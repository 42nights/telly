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

/** `POST /api/families/:familyId/vision/medicine-detections` body. */
export const MedicineDetectionRequest = Schema.Struct({
	frame: VisionFrame,
	image: Schema.Struct({
		type: Schema.Literals(["image/jpeg", "image/png"]),
		/** Base64 bytes; at most `MAX_VISION_IMAGE_BYTES` once decoded. */
		data: Schema.String.check(Schema.isMinLength(1), Schema.isBase64()),
	}),
});
export type MedicineDetectionRequest = typeof MedicineDetectionRequest.Type;

/** One medicine container found in the frame. */
export const MedicineDetection = Schema.Struct({
	/** Name printed on the container, or `null` when the model could not read it. */
	label: Schema.NullOr(Schema.String),
	/** Model-reported confidence (0–1) that this is a medicine container; not calibrated. */
	confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	/** The label is unreadable or confidence is low: the user must check the label before relying on it. */
	needsVerification: Schema.Boolean,
	/** Bounding box in camera-frame pixels (same space as `frame.width` × `frame.height`). */
	box: Schema.Struct({
		x: Schema.Finite,
		y: Schema.Finite,
		width: Schema.Finite,
		height: Schema.Finite,
	}),
});
export type MedicineDetection = typeof MedicineDetection.Type;

/**
 * Detections for exactly one frame. A found box does not confirm a dose was taken, and an empty
 * list means "none found in this frame", not "no medicine nearby".
 */
export const MedicineDetections = Schema.Struct({
	frame: VisionFrame,
	detections: Schema.Array(MedicineDetection),
	/** Provider model that produced the detections. */
	model: Schema.String,
	analyzedAt: UtcTime,
});
export type MedicineDetections = typeof MedicineDetections.Type;
