// Lock-on (#348): Gemini finds the object once; this keeps finding it in every live video frame.
// A fixed grid of gray samples from the found box (the template) is matched by normalized
// correlation, so brightness and contrast changes do not matter. While locked it searches near
// the last place; once lost it searches the whole frame until the object shows again.
// ponytail: plain template match; no rotation search, so a strongly turned object is lost until a
// Gemini re-check locks on again. Add rotation steps or ORB features if that happens often.

/** A small grayscale copy of a camera frame. */
export type Gray = {
	readonly width: number;
	readonly height: number;
	readonly data: Float32Array;
};

export type Box = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

/** Where the object is in a gray frame: its center, and its size against the template's. */
export type Pose = {
	readonly x: number;
	readonly y: number;
	readonly scale: number;
};

type Template = {
	/** Sample offsets from the box center, in gray pixels at scale 1. */
	readonly dx: Float32Array;
	readonly dy: Float32Array;
	readonly values: Float32Array;
	readonly width: number;
	readonly height: number;
};

export type Track = {
	readonly fine: Template;
	/** Fewer samples, for the wide search. */
	readonly coarse: Template;
	/** The last place it was matched. */
	readonly pose: Pose;
	readonly locked: boolean;
	/** Frames in a row without a match while locked. */
	readonly misses: number;
};

/** Gray frames are this wide. */
export const WORK_WIDTH = 160;
/** A locked object stays locked down to this match. */
// ponytail: fixed thresholds tuned on phone video; make them per-device if markers jump or drop.
const HOLD = 0.5;
/** A lost object locks on again from this match: higher, so the background is not taken for it. */
const REACQUIRE = 0.7;
/** A locked object is lost after this many frames in a row without a match. */
export const LOST_AFTER = 5;
/** A box needs this share of its samples inside the frame to match. */
const IN_FRAME = 0.7;

/** Gray pixels from RGBA, each the sum of `block`×`block` pixels (correlation ignores the scale). */
export const toGray = (
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	block = 1,
): Gray => {
	const w = Math.floor(width / block);
	const h = Math.floor(height / block);
	const data = new Float32Array(w * h);
	for (let y = 0; y < h * block; y++)
		for (let x = 0; x < w * block; x++) {
			const i = (y * width + x) * 4;
			const cell = Math.floor(y / block) * w + Math.floor(x / block);
			data[cell] =
				(data[cell] ?? 0) +
				0.299 * (rgba[i] ?? 0) +
				0.587 * (rgba[i + 1] ?? 0) +
				0.114 * (rgba[i + 2] ?? 0);
		}
	return { width: w, height: h, data };
};

const template = (gray: Gray, box: Box, grid: number): Template => {
	const nx = Math.max(3, Math.min(grid, Math.round(box.width)));
	const ny = Math.max(3, Math.min(grid, Math.round(box.height)));
	const dx = new Float32Array(nx * ny);
	const dy = new Float32Array(nx * ny);
	const values = new Float32Array(nx * ny);
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) {
			const k = j * nx + i;
			dx[k] = ((i + 0.5) / nx - 0.5) * box.width;
			dy[k] = ((j + 0.5) / ny - 0.5) * box.height;
			const x = Math.min(
				gray.width - 1,
				Math.max(0, Math.round(cx + (dx[k] ?? 0))),
			);
			const y = Math.min(
				gray.height - 1,
				Math.max(0, Math.round(cy + (dy[k] ?? 0))),
			);
			values[k] = gray.data[y * gray.width + x] ?? 0;
		}
	return { dx, dy, values, width: box.width, height: box.height };
};

/** Correlation (-1…1) of the template with the frame at a pose; -1 when mostly outside. */
const score = (gray: Gray, t: Template, x: number, y: number, s: number) => {
	let n = 0;
	let sf = 0;
	let st = 0;
	let sff = 0;
	let stt = 0;
	let sft = 0;
	for (let k = 0; k < t.values.length; k++) {
		const px = Math.round(x + s * (t.dx[k] ?? 0));
		const py = Math.round(y + s * (t.dy[k] ?? 0));
		if (px < 0 || py < 0 || px >= gray.width || py >= gray.height) continue;
		const f = gray.data[py * gray.width + px] ?? 0;
		const v = t.values[k] ?? 0;
		n++;
		sf += f;
		st += v;
		sff += f * f;
		stt += v * v;
		sft += f * v;
	}
	if (n < IN_FRAME * t.values.length) return -1;
	const vf = sff - (sf * sf) / n;
	const vt = stt - (st * st) / n;
	return vf <= 1e-6 || vt <= 1e-6
		? 0
		: (sft - (sf * st) / n) / Math.sqrt(vf * vt);
};

type Match = Pose & { readonly score: number };

const scan = (
	gray: Gray,
	t: Template,
	scales: readonly number[],
	area: { x0: number; x1: number; y0: number; y1: number },
	step: number,
): Match => {
	let best: Match = { x: area.x0, y: area.y0, scale: 1, score: -2 };
	for (const scale of scales)
		for (let y = area.y0; y <= area.y1; y += step)
			for (let x = area.x0; x <= area.x1; x += step) {
				const value = score(gray, t, x, y, scale);
				if (value > best.score) best = { x, y, scale, score: value };
			}
	return best;
};

/** The best pose within one coarse step of `m`, at full detail. */
const refine = (gray: Gray, t: Template, m: Match, step: number) =>
	scan(
		gray,
		t,
		[m.scale * 0.97, m.scale, m.scale * 1.03].map(clampScale),
		{ x0: m.x - step, x1: m.x + step, y0: m.y - step, y1: m.y + step },
		1,
	);

const clampScale = (s: number) => Math.min(3, Math.max(0.4, s));

/** Starts locked on `box` (gray pixels) of `gray`. */
export const lockOn = (gray: Gray, box: Box): Track => ({
	fine: template(gray, box, 20),
	coarse: template(gray, box, 10),
	pose: { x: box.x + box.width / 2, y: box.y + box.height / 2, scale: 1 },
	locked: true,
	misses: 0,
});

/** The track after one more frame. */
export const follow = (track: Track, gray: Gray): Track => {
	const { fine, coarse, pose } = track;
	const size = Math.max(fine.width, fine.height) * pose.scale;
	if (track.locked) {
		// Up to 24 gray px (15% of the frame) of travel per frame: a fast pan at 30 fps.
		const r = Math.round(Math.min(24, Math.max(10, 0.75 * size)));
		const near = scan(
			gray,
			coarse,
			[pose.scale * 0.95, pose.scale, pose.scale * 1.05].map(clampScale),
			{ x0: pose.x - r, x1: pose.x + r, y0: pose.y - r, y1: pose.y + r },
			2,
		);
		const m = refine(gray, fine, near, 2);
		if (m.score >= HOLD) return { ...track, pose: m, misses: 0 };
		const misses = track.misses + 1;
		return { ...track, misses, locked: misses < LOST_AFTER };
	}
	// Steps of at least 3 px keep a whole-frame search near 10 ms on a laptop (a small object).
	const step = Math.max(
		3,
		Math.round((Math.min(fine.width, fine.height) * pose.scale) / 8),
	);
	const wide = scan(
		gray,
		coarse,
		[pose.scale * 0.8, pose.scale, pose.scale * 1.25].map(clampScale),
		{ x0: 0, x1: gray.width - 1, y0: 0, y1: gray.height - 1 },
		step,
	);
	const m = refine(gray, fine, wide, step);
	return m.score >= REACQUIRE
		? { ...track, pose: m, locked: true, misses: 0 }
		: track;
};

/** The box of a pose, in gray pixels. */
export const boxOf = (track: Track): Box => {
	const { pose, fine } = track;
	const width = fine.width * pose.scale;
	const height = fine.height * pose.scale;
	return { x: pose.x - width / 2, y: pose.y - height / 2, width, height };
};

/** The tracker asks Gemini again at most this often. */
export const RECHECK_EVERY_MS = 5_000;
/** And only this long into one loss, so a forgotten finder does not keep paying for checks. */
export const RECHECK_FOR_MS = 30_000;

/**
 * True when a lost object should be looked for by Gemini again: it is lost, it should be in view
 * (or the phone cannot tell), the loss is recent, and the last check is `RECHECK_EVERY_MS` old.
 */
export const recheckDue = ({
	lostAt,
	inView,
	lastAt,
	now,
}: {
	readonly lostAt: number | null;
	readonly inView: boolean;
	readonly lastAt: number | null;
	readonly now: number;
}) =>
	lostAt !== null &&
	inView &&
	now - lostAt < RECHECK_FOR_MS &&
	(lastAt === null || now - lastAt >= RECHECK_EVERY_MS);
