/** A marker older than this is cleared: what the wearer sees may have changed. */
export const MARKER_TTL_MS = 60_000;
/** Below this model confidence no marker is drawn. The server asks for a label check below 0.7. */
export const MARKER_MIN_CONFIDENCE = 0.4;
/** Mean brightness change (0–255) between the checked frame and the live video that counts as motion. */
// ponytail: one fixed threshold; make it a per-device setting if phones clear markers too eagerly.
export const MOVED_ABOVE = 18;
/** How often the live video is compared with the checked frame. */
export const MOTION_EVERY_MS = 500;

export type ClearedReason = "moved" | "old";

const SIDE = { width: 32, height: 24 } as const;

/**
 * A tiny grayscale copy of RGBA pixels with the mean brightness removed, so an exposure change
 * alone does not count as motion.
 */
export const signature = (rgba: Uint8ClampedArray): Float32Array => {
	const out = new Float32Array(rgba.length / 4);
	let sum = 0;
	for (let i = 0; i < out.length; i++) {
		const l =
			0.299 * (rgba[i * 4] ?? 0) +
			0.587 * (rgba[i * 4 + 1] ?? 0) +
			0.114 * (rgba[i * 4 + 2] ?? 0);
		out[i] = l;
		sum += l;
	}
	const mean = sum / out.length;
	for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) - mean;
	return out;
};

/** Mean absolute difference (0–255) between two signatures of the same size. */
export const difference = (a: Float32Array, b: Float32Array): number => {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
	return sum / a.length;
};

/** Why a checked picture's markers must go, or null while they still match what the camera sees. */
export const clearedReason = (
	capturedAt: number,
	now: number,
	change: number | null,
): ClearedReason | null => {
	if (change !== null && change > MOVED_ABOVE) return "moved";
	if (now - capturedAt > MARKER_TTL_MS) return "old";
	return null;
};

/**
 * The signature of a captured frame (`canvas`), or of the video's current frame drawn the same way:
 * full size first, then shrunk, because browsers shrink a video and a canvas with different filters.
 * Null when no frame shows; a video can report data before its frame is drawable (transparent).
 */
export const sample = (
	source: HTMLVideoElement | HTMLCanvasElement | null,
): Float32Array | null => {
	let full = source;
	if (source instanceof HTMLVideoElement) {
		if (
			!source.isConnected ||
			source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
		)
			return null;
		full = document.createElement("canvas");
		full.width = source.videoWidth;
		full.height = source.videoHeight;
		full.getContext("2d")?.drawImage(source, 0, 0, full.width, full.height);
	}
	if (full === null || full.width === 0) return null;
	const canvas = document.createElement("canvas");
	canvas.width = SIDE.width;
	canvas.height = SIDE.height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context === null) return null;
	context.drawImage(full, 0, 0, SIDE.width, SIDE.height);
	const { data } = context.getImageData(0, 0, SIDE.width, SIDE.height);
	return data[3] === 0 ? null : signature(data);
};
