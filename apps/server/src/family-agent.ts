// Answers a family member's question with the Grokbot agent, using only the family's own records.
// The tools read a snapshot of records that the database already scoped to the caller's family.
// The server, not the model, reports which records the answer used and which metrics had none.
import type { HealthSample } from "@health/contracts";
import type {
	Evidence,
	FamilyAnswer,
	FamilyQuestion,
} from "@health/contracts/family";
import { Effect, Schema } from "effect";
import { askGrokbot, type GrokbotConfig } from "./integrations/grokbot";

// ponytail: one freshness window for every metric; per-metric windows when a metric needs one.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SampleQuery = Schema.Struct({
	metric: Schema.String,
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
	),
});

const instructions = (now: Date, timeZone: string) =>
	[
		"You answer questions from family members of a person with memory loss about that person's health records.",
		"Use only the results of your tools. Never estimate, invent, or assume a reading, and give no diagnosis.",
		"For every value you state, give its source and its source time, and say when it is synthetic, unvalidated, or stale.",
		"When a tool reports a metric as unavailable or there are no records, say that the data is unavailable. Missing data is never an all-clear.",
		"WHOOP data through NOOP is not connected. Never give WHOOP readings or WHOOP-based advice.",
		`The current time is ${now.toISOString()}. Write times in the ${timeZone} time zone.`,
		"Answer briefly, in the language of the question.",
	].join("\n");

/** Runs one question against the family's records and collects the records the agent read. */
export const answerQuestion = (
	config: GrokbotConfig,
	samples: ReadonlyArray<HealthSample>,
	{ question, timeZone = "UTC" }: FamilyQuestion,
	now: Date,
) => {
	const evidence = new Map<string, Evidence>();
	const unavailable = new Set<string>();
	const tools = [
		{
			name: "list_health_metrics",
			description:
				"Lists every metric the family has records for, with unit, record count, sources, and the latest source time.",
			parameters: { type: "object", properties: {} },
			run: () => ({
				metrics: [...Map.groupBy(samples, (s) => s.metric)].map(
					([metric, rows]) => ({
						metric,
						units: [...new Set(rows.map((r) => r.unit))],
						records: rows.length,
						sources: [...new Set(rows.map((r) => r.source))],
						latestSourceTime: rows
							.map((r) => r.sourceTime)
							.sort()
							.at(-1),
					}),
				),
				noop: { status: "not_connected", readings: "none" },
			}),
		},
		{
			name: "read_health_samples",
			description:
				"Reads the newest records of one metric, newest first, with value, unit, source, source time, receive time, quality, synthetic flag, and stale flag.",
			parameters: {
				type: "object",
				properties: {
					metric: {
						type: "string",
						description: "A metric name from list_health_metrics",
					},
					limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
				},
				required: ["metric"],
			},
			run: (args: unknown) => {
				const query = Schema.decodeUnknownOption(SampleQuery)(args);
				if (query._tag === "None") return { error: "invalid arguments" };
				const { metric, limit = 20 } = query.value;
				const rows = samples
					.filter((s) => s.metric === metric)
					.sort((a, b) => b.sourceTime.localeCompare(a.sourceTime))
					.slice(0, limit)
					.map(
						(sample): Evidence => ({
							...sample,
							stale:
								now.getTime() - Date.parse(sample.sourceTime) > STALE_AFTER_MS,
						}),
					);
				if (rows.length === 0) {
					unavailable.add(metric);
					return { metric, status: "unavailable", reason: "no records" };
				}
				for (const row of rows) evidence.set(row.id, row);
				return { metric, status: "ok", records: rows };
			},
		},
	];
	return askGrokbot(config, {
		instructions: instructions(now, timeZone),
		question,
		tools,
	}).pipe(
		Effect.map(
			({ text, model }): FamilyAnswer => ({
				answer: text,
				evidence: [...evidence.values()],
				unavailable: [...unavailable],
				model,
				answeredAt: now.toISOString(),
			}),
		),
	);
};
