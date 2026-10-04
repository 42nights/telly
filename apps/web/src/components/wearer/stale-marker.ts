/** A marker older than this is cleared: what the wearer sees may have changed. */
export const MARKER_TTL_MS = 60_000;
/** Below this model confidence no marker is drawn. The server asks for a label check below 0.7. */
export const MARKER_MIN_CONFIDENCE = 0.4;
/** Mean brightness change (0–255) between the answer-time frame and the live video that counts as motion. */
// ponytail: one fixed threshold; make it a per-device setting if phones clear markers too eagerly.
export const MOVED_ABOVE = 18;
/** Motion must last this many checks in a row, so hand jitter does not clear the marker. */
export const MOVED_CHECKS = 2;
/** How often the live video is compared with the answer-time frame. */
export const MOTION_EVERY_MS = 500;

export type ClearedReason = "moved" | "old";

const SIDE = { width: 32, height: 24 } as const;
/** Each signature cell averages BLOCK×BLOCK drawn pixels, so noise and 1 px shifts average out. */
const BLOCK = 8;

/**
 * A tiny grayscale copy of RGBA pixels (32×24 cells of `block`×`block` pixels each, averaged) with
 * the mean brightness removed, so an exposure change alone does not count as motion.
 */
export const signature = (rgba: Uint8ClampedArray, block = 1): Float32Array => {
	const out = new Float32Array(SIDE.width * SIDE.height);
	const width = SIDE.width * block;
	for (let i = 0; i < rgba.length / 4; i++) {
		const cell =
			Math.floor(i / width / block) * SIDE.width +
			Math.floor((i % width) / block);
		out[cell] =
			(out[cell] ?? 0) +
			0.299 * (rgba[i * 4] ?? 0) +
			0.587 * (rgba[i * 4 + 1] ?? 0) +
			0.114 * (rgba[i * 4 + 2] ?? 0);
	}
	let sum = 0;
	for (let i = 0; i < out.length; i++) {
		out[i] = (out[i] ?? 0) / (block * block);
		sum += out[i] ?? 0;
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

/**
 * Why a checked picture's markers must go, or null while they still match what the camera sees.
 * `movedChecks` counts the checks in a row whose change was over `MOVED_ABOVE`.
 */
export const clearedReason = (
	capturedAt: number,
	now: number,
	movedChecks: number,
): ClearedReason | null => {
	if (movedChecks >= MOVED_CHECKS) return "moved";
	if (now - capturedAt > MARKER_TTL_MS) return "old";
	return null;
};

/**
 * The signature of the video's current frame. The answer-time reference and every live check use
 * this one path, so size, orientation, and scaling always match.
 * Null when no frame shows; a video can report data before its frame is drawable (transparent).
 */
export const sample = (video: HTMLVideoElement | null): Float32Array | null => {
	if (
		video === null ||
		!video.isConnected ||
		video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
		video.videoWidth === 0
	)
		return null;
	const canvas = document.createElement("canvas");
	canvas.width = SIDE.width * BLOCK;
	canvas.height = SIDE.height * BLOCK;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context === null) return null;
	context.drawImage(video, 0, 0, canvas.width, canvas.height);
	const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
	return data[3] === 0 ? null : signature(data, BLOCK);
};
