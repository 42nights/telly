import { Schema } from "effect";

/** Largest decoded image the vision route accepts. Clients downscale larger frames first. */
export const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;

const Pixels = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 16384 }),
);
const Offset = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: 16383 }),
);
export const UtcTime = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/),
);

/** A rectangle in camera-frame pixels; `x`/`y` is the top-left corner. */
export const PixelRect = Schema.Struct({
	x: Offset,
	y: Offset,
	width: Pixels,
	height: Pixels,
});
export type PixelRect = typeof PixelRect.Type;

/**
 * Provenance of the uploaded image. The client crops `crop` out of the `width` × `height` camera
 * frame, rotates it clockwise by `rotation` degrees, may scale it, and encodes it. The server maps
 * every box back into frame pixels, so a marker lands on the frame it was found in.
 */
export const VisionFrame = Schema.Struct({
	/** Client-chosen id of the camera frame. */
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	/** When the camera captured the frame (ISO 8601 UTC). Clients drop answers for stale frames. */
	capturedAt: UtcTime,
	width: Pixels,
	height: Pixels,
	/** The encoded region. Send `{ x: 0, y: 0, width, height }` for the full frame. */
	crop: PixelRect,
	rotation: Schema.Literals([0, 90, 180, 270]),
});
export type VisionFrame = typeof VisionFrame.Type;

/**
 * What kind of personal object a detection is (#301). Medicine keeps its own extra checks: its
 * label is only ever the printed name, and an unread label must be checked by the person.
 */
export const OBJECT_CATEGORIES = [
	"keys",
	"glasses",
	"wallet",
	"phone",
	"remote",
	"medicine",
	"hearing aid",
	"bag",
	"other",
] as const;
export const ObjectCategory = Schema.Literals(OBJECT_CATEGORIES);
export type ObjectCategory = typeof ObjectCategory.Type;

/** `POST /api/families/:familyId/vision/object-detections` body. */
export const ObjectDetectionRequest = Schema.Struct({
	frame: VisionFrame,
	image: Schema.Struct({
		type: Schema.Literals(["image/jpeg", "image/png"]),
		/** Base64 bytes; at most `MAX_VISION_IMAGE_BYTES` once decoded. */
		data: Schema.String.check(Schema.isMinLength(1), Schema.isBase64()),
	}),
});
export type ObjectDetectionRequest = typeof ObjectDetectionRequest.Type;

/** One personal object found in the frame. */
export const ObjectDetection = Schema.Struct({
	category: ObjectCategory,
	/**
	 * A short everyday name ("keys", "reading glasses"). For medicine only the name printed on the
	 * container; `null` when the model could not read it.
	 */
	label: Schema.NullOr(Schema.String),
	/** Model-reported confidence (0–1) in the category; not calibrated. */
	confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	/** No label or a low confidence: the person must check the object before relying on it. */
	needsVerification: Schema.Boolean,
	/** Bounding box in camera-frame pixels (same space as `frame.width` × `frame.height`). */
	box: Schema.Struct({
		x: Schema.Finite,
		y: Schema.Finite,
		width: Schema.Finite,
		height: Schema.Finite,
	}),
});
export type ObjectDetection = typeof ObjectDetection.Type;

/**
 * Detections for exactly one frame, the main object in view first. A found box does not confirm a
 * dose was taken, and an empty list means "none found in this frame", not "nothing nearby".
 */
export const ObjectDetections = Schema.Struct({
	frame: VisionFrame,
	detections: Schema.Array(ObjectDetection),
	/** Provider model that produced the detections. */
	model: Schema.String,
	analyzedAt: UtcTime,
});
export type ObjectDetections = typeof ObjectDetections.Type;
