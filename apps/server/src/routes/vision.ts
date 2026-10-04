import {
	MAX_VISION_IMAGE_BYTES,
	type MedicineDetection,
	MedicineDetectionRequest,
	type MedicineDetections,
	type VisionFrame,
} from "@health/contracts/vision";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import {
	createGeminiDetector,
	GEMINI_VISION_MODEL,
	type GeminiBox,
	type GeminiConfig,
} from "../integrations/gemini";

/** Below this model confidence a marker asks the user to check the label. */
const VERIFY_BELOW = 0.7;

// Base64 grows 4/3; the rest is frame metadata.
const MAX_BODY_BYTES = Math.ceil(MAX_VISION_IMAGE_BYTES / 3) * 4 + 16 * 1024;

/** Reads the pixel size from a PNG or baseline/progressive JPEG header; `undefined` if malformed. */
export const imageSize = (
	type: MedicineDetectionRequest["image"]["type"],
	bytes: Buffer,
): { width: number; height: number } | undefined => {
	if (type === "image/png") {
		const signature = "89504e470d0a1a0a0000000d49484452";
		if (bytes.length < 24 || bytes.toString("hex", 0, 16) !== signature) return;
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
	let offset = 2;
	while (offset + 9 <= bytes.length) {
		if (bytes[offset] !== 0xff) return;
		const marker = bytes.readUInt8(offset + 1);
		// SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG), and CC (DAC) do not.
		if (
			marker >= 0xc0 &&
			marker <= 0xcf &&
			![0xc4, 0xc8, 0xcc].includes(marker)
		)
			return {
				height: bytes.readUInt16BE(offset + 5),
				width: bytes.readUInt16BE(offset + 7),
			};
		offset += 2 + bytes.readUInt16BE(offset + 2);
	}
};

/** Maps a 0–1000 box in the sent (cropped, rotated, scaled) image back to camera-frame pixels. */
export const toFramePixels = (
	frame: VisionFrame,
	[ymin, xmin, ymax, xmax]: GeminiBox["box"],
): MedicineDetection["box"] => {
	// Undo the clockwise rotation: image-normalized (u, v) → crop-normalized point.
	const unrotate = (u: number, v: number): [number, number] => {
		switch (frame.rotation) {
			case 0:
				return [u, v];
			case 90:
				return [v, 1 - u];
			case 180:
				return [1 - u, 1 - v];
			case 270:
				return [1 - v, u];
		}
	};
	const [ax, ay] = unrotate(xmin / 1000, ymin / 1000);
	const [bx, by] = unrotate(xmax / 1000, ymax / 1000);
	const { crop } = frame;
	return {
		x: crop.x + Math.min(ax, bx) * crop.width,
		y: crop.y + Math.min(ay, by) * crop.height,
		width: Math.abs(bx - ax) * crop.width,
		height: Math.abs(by - ay) * crop.height,
	};
};

/** Rejects an image that does not match its declared type or provenance. */
const checkImage = ({ frame, image }: MedicineDetectionRequest) => {
	const invalid = (message: string) =>
		new ApiFailure("invalid_request", message);
	const { crop } = frame;
	if (crop.x + crop.width > frame.width || crop.y + crop.height > frame.height)
		throw invalid("frame.crop extends outside the frame");
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length > MAX_VISION_IMAGE_BYTES)
		throw invalid(`image is larger than ${MAX_VISION_IMAGE_BYTES} bytes`);
	const size = imageSize(image.type, bytes);
	if (size === undefined || size.width === 0 || size.height === 0)
		throw invalid(`image is not a valid ${image.type}`);
	const turned = frame.rotation === 90 || frame.rotation === 270;
	const [w, h] = turned ? [crop.height, crop.width] : [crop.width, crop.height];
	// Same aspect ratio as the rotated crop, allowing 1 px rounding per side from scaling.
	if (Math.abs(size.width * h - size.height * w) > w + h)
		throw invalid("image aspect ratio does not match the rotated frame.crop");
};

/**
 * Vision routes, mounted at `/api/families/:familyId/vision` behind sign-in and the family check.
 * Without a Gemini config (no `GEMINI_API_KEY`) every request gets `unavailable`, never an empty
 * result.
 */
export const visionRoutes = (gemini: GeminiConfig | undefined) => {
	const detect = gemini && createGeminiDetector(gemini);
	return new Hono<FamilyEnv>().post(
		"/medicine-detections",
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: () => {
				throw new ApiFailure("invalid_request", "The body is too large");
			},
		}),
		async (c) => {
			if (detect === undefined)
				throw new ApiFailure(
					"unavailable",
					"Medicine detection is not configured",
				);
			// decodeBody's message never echoes the body, so the image stays out of the reply.
			const request = await decodeBody(c, MedicineDetectionRequest);
			checkImage(request);

			// The request signal interrupts the provider call when the client disconnects.
			const result = await Effect.runPromiseExit(detect(request.image), {
				signal: c.req.raw.signal,
			});
			if (Exit.isSuccess(result))
				return c.json({
					frame: request.frame,
					model: GEMINI_VISION_MODEL,
					analyzedAt: new Date().toISOString(),
					detections: result.value.map(({ box, label, confidence }) => ({
						label,
						confidence,
						needsVerification: label === null || confidence < VERIFY_BELOW,
						box: toFramePixels(request.frame, box),
					})),
				} satisfies MedicineDetections);
			// 499: the client closed the request; nobody reads this response.
			if (Cause.hasInterruptsOnly(result.cause))
				return new Response(null, { status: 499 });
			const failure = Cause.findErrorOption(result.cause);
			if (failure._tag === "None") throw Cause.squash(result.cause);
			const { reason, status } = failure.value;
			console.warn("gemini vision failed", { reason, status });
			throw new ApiFailure(
				"upstream_error",
				reason === "timeout"
					? "Medicine detection timed out"
					: "Medicine detection failed",
			);
		},
	);
};
