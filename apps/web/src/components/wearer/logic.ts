import type { HealthSample } from "@health/contracts";

/** A heart-rate reading older than this is not shown as current. */
// ponytail: fixed 10 min window; read it from the family's alert threshold if they ever differ.
export const HEART_RATE_FRESH_MS = 10 * 60_000;
// Same rule as the server monitor: a source clock may run up to a minute ahead.
const MAX_CLOCK_AHEAD_MS = 60_000;

/** The usual adult resting band drawn on the range bar. A band only, never a score. */
export const USUAL_BPM = { low: 60, high: 100 } as const;
/** The range bar spans this many bpm. */
const BAR_BPM = { low: 30, high: 180 } as const;

/**
 * The newest validated, measured `heart_rate` sample in bpm for one family, or null when there is
 * none or the newest one is stale. Unvalidated and synthetic samples never count as a reading.
 */
export const currentHeartRate = (
	samples: readonly HealthSample[],
	familyId: string,
	now: number,
): HealthSample | null => {
	let newest: HealthSample | null = null;
	for (const s of samples)
		if (
			s.familyId === familyId &&
			s.metric === "heart_rate" &&
			s.unit === "bpm" &&
			s.quality === "validated" &&
			!s.synthetic &&
			(newest === null || s.sourceTime > newest.sourceTime)
		)
			newest = s;
	if (newest === null) return null;
	const age = now - Date.parse(newest.sourceTime);
	return age > HEART_RATE_FRESH_MS || age < -MAX_CLOCK_AHEAD_MS ? null : newest;
};

/** "just now", "42 s ago", "3 min ago", "2 h ago". */
export const ago = (ms: number): string => {
	const s = Math.round(ms / 1000);
	if (s < 5) return "just now";
	if (s < 60) return `${s} s ago`;
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	return `${Math.round(s / 3600)} h ago`;
};

/** One answer source in wearer words: "Heart rate 72 bpm · from phone · 3 min ago". */
export const evidenceLine = (
	sample: {
		readonly metric: string;
		readonly value: number;
		readonly unit: string;
		readonly source: string;
		readonly sourceTime: string;
		readonly stale: boolean;
	},
	now: number,
): string => {
	const metric = sample.metric.replaceAll("_", " ");
	const name = `${metric.charAt(0).toUpperCase()}${metric.slice(1)}`;
	const age = ago(now - Date.parse(sample.sourceTime));
	return `${name} ${sample.value} ${sample.unit} · from ${sample.source} · ${age}${sample.stale ? " (old)" : ""}`;
};

/** Where `bpm` sits on the range bar, as a percentage clamped to the bar. */
export const barPercent = (bpm: number): number =>
	Math.min(
		100,
		Math.max(0, ((bpm - BAR_BPM.low) / (BAR_BPM.high - BAR_BPM.low)) * 100),
	);

const MEDICINE_WORD =
	"meds?|medicines?|medications?|pills?|tablets?|capsules?|vitamins?|prescriptions?|inhalers?";
const MEDICINE = new RegExp(`\\b(?:${MEDICINE_WORD})\\b`, "i");
// "my" plus up to three describing words before the medicine word: "my blood pressure pills".
const MY_MEDICINE = new RegExp(
	`\\bmy\\s+((?:[a-z'-]+\\s+){0,3}?(?:${MEDICINE_WORD}))\\b`,
	"i",
);

/** True when a request asks about medicine, so it opens the medicine finder. */
export const isMedicineRequest = (request: string): boolean =>
	MEDICINE.test(request);

/**
 * The item a request names, in words to show the wearer: "Where are my meds?" → "your medicine",
 * "find my blood pressure pills" → "your blood pressure pills". Never a stored or per-item name.
 */
export const itemFromRequest = (request: string): string => {
	const named = MY_MEDICINE.exec(request)?.[1] ?? MEDICINE.exec(request)?.[0];
	if (named === undefined) return "your medicine";
	return `your ${named.toLowerCase().replace(/\bmeds?\b/, "medicine")}`;
};

type Box = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

/**
 * The marker for a box in frame pixels: the box clamped to the frame, and an arrow path from the
 * frame's bottom (or top, when the box sits low) to the nearest box edge.
 */
export const marker = (
	box: Box,
	frame: { readonly width: number; readonly height: number },
) => {
	const x = Math.min(Math.max(0, box.x), frame.width);
	const y = Math.min(Math.max(0, box.y), frame.height);
	const rect = {
		x,
		y,
		width: Math.min(box.x + box.width, frame.width) - x,
		height: Math.min(box.y + box.height, frame.height) - y,
	};
	const cx = rect.x + rect.width / 2;
	const fromTop = rect.y + rect.height / 2 > frame.height * 0.6;
	const tipY = fromTop ? rect.y : rect.y + rect.height;
	const startY = fromTop ? 0 : frame.height;
	const startX = frame.width / 2;
	// The arrow ends a little outside the box so it does not cover the label.
	const gap = Math.min(frame.height, frame.width) * 0.02;
	const endY = fromTop ? tipY - gap : tipY + gap;
	const midY = (startY + endY) / 2;
	// The head points at the box: up from below, down from above.
	const head = fromTop ? -gap * 1.5 : gap * 1.5;
	return {
		rect,
		arrow: `M${startX} ${startY} C ${startX} ${midY}, ${cx} ${midY}, ${cx} ${endY + head * 0.5}`,
		head: `${cx},${endY} ${cx - gap},${endY + head} ${cx + gap},${endY + head}`,
	};
};

/** A sighting older than this is shown as old. */
// ponytail: fixed 12 h; make it a family setting if containers move on another rhythm.
export const SIGHTING_OLD_MS = 12 * 3600_000;
/** Same limit as the vision route: below it, a detection asks the person to check the label. */
const SURE_CONFIDENCE = 0.7;

/**
 * How to qualify a remembered sighting. It is only ever "last seen", never a current place: it is
 * `outdated` once the person did not find it there, `old` after `SIGHTING_OLD_MS`, and `unsure`
 * when the label was not read or the detection had low confidence.
 */
export const sightingState = (
	sighting: {
		readonly seenAt: string;
		readonly notFoundAt: string | null;
		readonly confidence: number;
		readonly labelRead: boolean;
	},
	now: number,
) => ({
	outdated: sighting.notFoundAt !== null,
	old: now - Date.parse(sighting.seenAt) > SIGHTING_OLD_MS,
	unsure: !sighting.labelRead || sighting.confidence < SURE_CONFIDENCE,
});

/** A short direction to a box in the picture: "Look to the left, low down." */
export const direction = (
	box: Box,
	frame: { readonly width: number; readonly height: number },
): string => {
	const x = (box.x + box.width / 2) / frame.width;
	const y = (box.y + box.height / 2) / frame.height;
	const side =
		x < 1 / 3 ? "to the left" : x > 2 / 3 ? "to the right" : "straight ahead";
	const height = y < 1 / 3 ? ", high up" : y > 2 / 3 ? ", low down" : "";
	return `Look ${side}${height}.`;
};
