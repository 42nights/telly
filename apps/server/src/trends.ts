// Trend explanations from dated records, without a model (docs/board.html#db-hrv). The server relates
// wearable history, dated labs, and the asker's own report. It never diagnoses and never writes, so
// no record (synthetic or real) can start an alert or a nudge here. It offers a check-in, a review,
// and the routines and verified care instructions already agreed in the saved care plan (#26).
import type { HealthSample } from "@health/contracts";
import type { FinchnodeSubjectLabs } from "@health/contracts/reports";
import type {
	EvidenceKind,
	TrendExplanation,
	TrendObservation,
} from "@health/contracts/trends";
import type { CareFacts } from "./cooking/suggest";

const ASK = "not verified, ask your caregiver.";

/** Already-agreed routines and verified `care` instructions; never medication, never unverified. */
const carePlanOf = (care: CareFacts | null): TrendExplanation["carePlan"] => {
	if (care === null)
		return {
			status: "not_shared",
			routines: [],
			instructions: [],
			notes: [
				"The care plan is not shared with you, so no agreed routine is offered.",
			],
		};
	const { routines, timeZone } = care.profile;
	const caring = care.instructions.filter((i) => i.kind === "care");
	return {
		status: "shared",
		routines: (routines ?? []).map((r) => ({ ...r, timeZone })),
		instructions: caring
			.filter((i) => i.verification === "verified")
			.map(({ name, instruction, times, timeZone, source, effectiveDate }) => ({
				name,
				instruction,
				times,
				timeZone,
				source,
				effectiveDate,
			})),
		notes: [
			...(routines === null
				? ["Routines unknown."]
				: routines.length === 0
					? ["No routines saved."]
					: []),
			...caring
				.filter((i) => i.verification !== "verified")
				.map(
					(i) =>
						`${i.name} (${i.verification}, ${i.source}, ${i.effectiveDate}): ${ASK}`,
				),
			"Medication instructions are never offered from a trend.",
		],
	};
};

const DAY_MS = 24 * 60 * 60 * 1000;
// ponytail: one freshness window for every metric, as in family-tools.ts.
const STALE_AFTER_MS = DAY_MS;

/** Scores a device computes from measurements. */
const DERIVED: Record<string, true> = {
	recovery: true,
	daily_strain: true,
	strain: true,
	sleep_performance: true,
	vitality: true,
	body_age: true,
	stress: true,
};

const kindOf = (metric: string): EvidenceKind =>
	Object.hasOwn(DERIVED, metric)
		? "derived"
		: metric.startsWith("nutrition_")
			? "nutrition_estimate"
			: "measured";

// ponytail: English words only; add other languages when voice questions reach this route.
const HEART_ATTACK = /heart attack|cardiac arrest|myocardial|chest pain/i;

type Value = string | number;
type Point = { time: string; value: Value; syncedAt: string | null };
type Series = Pick<
	TrendObservation,
	"kind" | "label" | "source" | "synthetic" | "quality" | "unit"
>;

const direction = (values: readonly Value[]): TrendObservation["direction"] => {
	if (values.length < 2) return "single";
	// Labs often send numbers as text ("7.1"); text such as "negative" has no direction.
	const first = Number(values[0]);
	const last = Number(values.at(-1));
	if (
		!Number.isFinite(first) ||
		!Number.isFinite(last) ||
		String(values[0]).trim() === "" ||
		String(values.at(-1)).trim() === ""
	)
		return "text";
	// ponytail: first-to-last change with a 5% flat band; no smoothing and no significance test.
	if (Math.abs(last - first) <= Math.abs(first) * 0.05) return "flat";
	return last > first ? "up" : "down";
};

/** One observation from one series. `staleBefore`: a last value older than this is stale. */
const observe = (
	series: Series,
	unsorted: readonly Point[],
	now: number,
	staleBefore: number,
): TrendObservation => {
	const points = [...unsorted].sort(
		(a, b) => Date.parse(a.time) - Date.parse(b.time),
	);
	const values = points.map((point) => point.value);
	const first = points[0] as Point;
	const last = points.at(-1) as Point;
	const synced = points
		.flatMap((point) => (point.syncedAt === null ? [] : [point.syncedAt]))
		.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
	return {
		...series,
		from: first.time,
		to: last.time,
		first: first.value,
		last: last.value,
		count: points.length,
		direction: direction(values),
		lastSyncAt: synced ?? null,
		lastSyncMinutes:
			synced === undefined
				? null
				: Math.floor((now - Date.parse(synced)) / 60_000),
		stale: Date.parse(last.time) < staleBefore,
	};
};

/** Collects points per series key, then turns each series into one observation. */
const grouped = () => {
	const groups = new Map<string, { series: Series; points: Point[] }>();
	return {
		add: (series: Series, point: Point) => {
			const key = JSON.stringify(series);
			const group = groups.get(key) ?? { series, points: [] };
			group.points.push(point);
			groups.set(key, group);
		},
		observations: (now: number, staleBefore: number) =>
			[...groups.values()].map(({ series, points }) =>
				observe(series, points, now, staleBefore),
			),
	};
};

const sampleObservations = (
	samples: readonly HealthSample[],
	windowStart: number,
	now: number,
	unknown: string[],
) => {
	const series = grouped();
	const before = new Map<string, string>();
	for (const sample of samples) {
		if (Date.parse(sample.sourceTime) < windowStart) {
			const seen = before.get(sample.metric);
			if (seen === undefined || seen < sample.sourceTime)
				before.set(sample.metric, sample.sourceTime);
			continue;
		}
		series.add(
			{
				kind: kindOf(sample.metric),
				label: sample.metric,
				source: sample.source,
				synthetic: sample.synthetic,
				quality: sample.quality,
				unit: sample.unit,
			},
			{
				time: sample.sourceTime,
				value: sample.value,
				syncedAt: sample.receivedAt,
			},
		);
	}
	const observations = series.observations(now, now - STALE_AFTER_MS);
	const current = new Set(observations.map((o) => o.label));
	for (const [metric, time] of before)
		if (!current.has(metric))
			unknown.push(
				`${metric}: no samples in this period. The last one is from ${time}.`,
			);
	return observations;
};

/** Why some of one subject's labs may be missing: revoked or narrower consent, a partial sync. */
const subjectGaps = (subject: FinchnodeSubjectLabs) => [
	...(subject.access === "inactive"
		? ["Lab results: the patient stopped sharing them."]
		: subject.access === "not_granted"
			? ["Lab results: the patient's consent does not cover labs."]
			: []),
	...(subject.syncStatus !== null && subject.syncStatus !== "complete"
		? [`Lab results: the FinchNode sync is ${subject.syncStatus}.`]
		: []),
	...subject.warnings.map(
		(warning) => `Lab results: FinchNode warning ${warning}.`,
	),
];

const labObservations = (
	subjects: readonly FinchnodeSubjectLabs[] | string,
	windowStart: number,
	now: number,
	unknown: string[],
) => {
	if (typeof subjects === "string") {
		unknown.push(`Lab results: ${subjects}`);
		return [];
	}
	if (subjects.length === 0)
		unknown.push("Lab results: no FinchNode record is linked to this family.");
	const series = grouped();
	for (const subject of subjects) {
		unknown.push(...subjectGaps(subject));
		for (const lab of subject.labs) {
			if (lab.date === null || lab.value === null) {
				unknown.push(
					`${lab.name}: the source gave no ${lab.date === null ? "date" : "value"}.`,
				);
				continue;
			}
			series.add(
				{
					kind: "measured",
					label: lab.name,
					source: `FinchNode · ${lab.sourceName ?? lab.source ?? "unnamed source"}`,
					synthetic: subject.synthetic,
					quality: "source_reported",
					unit: lab.unit,
				},
				{
					time: lab.date,
					value: lab.value,
					syncedAt: lab.syncedAt ?? subject.dataAsOf,
				},
			);
		}
	}
	// Labs keep their own dates: one older than the requested period is stale, never re-dated.
	return series.observations(now, windowStart);
};

/** Two sources of the same thing that moved in opposite directions, or use different units. */
const conflictsOf = (observations: readonly TrendObservation[]) => {
	const byLabel = Map.groupBy(observations, (o) => o.label);
	return [...byLabel].flatMap(([label, group]) => {
		const found: string[] = [];
		const up = group.find((o) => o.direction === "up");
		const down = group.find((o) => o.direction === "down");
		if (up !== undefined && down !== undefined)
			found.push(
				`${label}: ${up.source} went up while ${down.source} went down.`,
			);
		const units = new Set(group.map((o) => o.unit ?? "no unit"));
		if (units.size > 1)
			found.push(
				`${label}: the sources use different units (${[...units].join(", ")}).`,
			);
		return found;
	});
};

export type TrendInput = {
	readonly question: string;
	readonly days: number;
	readonly now: Date;
	/** The family's samples only. */
	readonly samples: readonly HealthSample[];
	/** The linked subjects' labs, or why none could be read. */
	readonly labs: readonly FinchnodeSubjectLabs[] | string;
	/** The asker's database identity. */
	readonly asker: string;
	/** The saved care plan, or `null` when the asker has no `health_records` access. */
	readonly care: CareFacts | null;
};

/** Relates the dated records to the question. Deterministic: the same records give the same reply. */
export const explainTrend = (input: TrendInput): TrendExplanation => {
	const now = input.now.getTime();
	const nowIso = input.now.toISOString();
	const windowStart = now - input.days * DAY_MS;
	const unknown = ["WHOOP data through NOOP: not connected."];
	const samples = sampleObservations(input.samples, windowStart, now, unknown);
	if (samples.length === 0)
		unknown.push(
			`No wearable or device samples in the last ${input.days} days.`,
		);
	const labs = labObservations(input.labs, windowStart, now, unknown);
	const measured = [...samples, ...labs];
	if (!measured.some((o) => o.kind === "nutrition_estimate"))
		unknown.push("Nutrition estimates: none are recorded.");
	const reported: TrendObservation = {
		kind: "reported",
		label: "question",
		source: input.asker,
		synthetic: false,
		quality: "self_reported",
		unit: null,
		from: nowIso,
		to: nowIso,
		first: input.question,
		last: input.question,
		count: 1,
		direction: "single",
		lastSyncAt: nowIso,
		lastSyncMinutes: 0,
		stale: false,
	};
	return {
		question: input.question,
		from: new Date(windowStart).toISOString(),
		to: nowIso,
		observations: [reported, ...measured],
		unknown,
		conflicts: conflictsOf(measured),
		carePlan: carePlanOf(input.care),
		nextSteps: [
			{
				kind: "check_in",
				text: "Check in with the person: ask how they feel and what they noticed.",
			},
			{
				kind: "review",
				text: "Bring these dated records to the next review with the care team.",
			},
		],
		cautions: [
			...(HEART_ATTACK.test(input.question)
				? [
						"Telly cannot detect or predict a heart attack. For chest pain or other emergency signs, call your local emergency number now.",
					]
				: []),
			"A change or a correlation in these records is not a diagnosis.",
			"A better wearable score does not prove better health.",
			"Do not change medicine, diet, fluids, or exercise because of these numbers alone. Ask the care team.",
			...(measured.some((o) => o.synthetic)
				? [
						"Records marked synthetic are demo data, not real measurements. They start no alert or nudge.",
					]
				: []),
		],
		generatedAt: nowIso,
	};
};
