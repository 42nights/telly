// Provider-independent family tools for the chat model. A chat adapter (Gemini) offers `tools` to
// the model, passes each function call to `run`, and returns the result to the model. Every call
// goes through Fetch.ai Agentverse (`callAgentTool`), never around it. The server, not the model,
// collects which records the answer can cite (`cited`), with source and freshness.
import type { Alert } from "@health/contracts";
import type { CitedRecords, Evidence } from "@health/contracts/chat";
import { ToolRequest } from "@health/contracts/tools";
import { Schema, SchemaAST } from "effect";
import { callAgentTool, type FetchAgentConfig } from "./integrations/fetch";

/** One function the model may call. `parameters` is JSON Schema with an object root. */
export type FamilyToolSpec = {
	readonly name: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
};

export type FamilyTools = {
	/** Rules that keep an answer tied to the records. Put them in the model's instructions. */
	readonly rules: string;
	readonly tools: ReadonlyArray<FamilyToolSpec>;
	/**
	 * Runs one model function call for the family. Arguments that do not match the tool schema
	 * return `{ error }` for the model. A Fetch.ai or server failure rejects with `ApiFailure`:
	 * the answer must stop, never continue without the data.
	 */
	readonly run: (
		name: string,
		args: unknown,
		signal?: AbortSignal,
	) => Promise<unknown>;
	/** Records the tool calls returned so far, for the answer reply. */
	readonly cited: () => CitedRecords;
};

// ponytail: one freshness window for every metric; per-metric windows when a metric needs one.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const specs: ReadonlyArray<FamilyToolSpec> = ToolRequest.members.map(
	(member) => ({
		name: member.fields.tool.literal,
		description:
			SchemaAST.resolveDescription(member.ast) ?? member.fields.tool.literal,
		parameters: Schema.toJsonSchemaDocument(member.fields.input).schema,
	}),
);

/**
 * The family tools for one question. `now` decides which records are stale; `timeZone` (IANA)
 * is the zone the answer writes times in.
 */
export const familyTools = (
	fetchAgent: FetchAgentConfig | undefined,
	familyId: bigint,
	now: Date,
	timeZone = "UTC",
): FamilyTools => {
	const evidence = new Map<string, Evidence>();
	const alerts = new Map<string, Alert>();
	const unavailable = new Set<string>();
	return {
		rules: [
			"You help a person with memory loss and their family with questions about that person's health records.",
			"Use only the results of your tools. Never estimate, invent, or assume a reading, and give no diagnosis.",
			"For every value you state, give its source and its source time, and say when it is synthetic, unvalidated, or stale.",
			"When a tool returns no records, say that the data is unavailable. Missing data is never an all-clear.",
			"WHOOP data through NOOP is not connected. Never give WHOOP readings or WHOOP-based advice.",
			`The current time is ${now.toISOString()}. Write times in the ${timeZone} time zone.`,
			"Answer briefly, in the language of the question.",
		].join("\n"),
		tools: specs,
		run: async (name, args, signal) => {
			const request = Schema.decodeUnknownOption(ToolRequest)(
				{ tool: name, input: args },
				{ onExcessProperty: "error" },
			);
			if (request._tag === "None")
				return {
					error: `${name} is not a tool, or its arguments do not match`,
				};
			const response = await callAgentTool(
				fetchAgent,
				familyId,
				request.value,
				signal,
			);
			if (response.tool === "alerts") {
				for (const alert of response.alerts) alerts.set(alert.id, alert);
				return response;
			}
			const samples = response.samples.map(
				(sample): Evidence => ({
					...sample,
					stale: now.getTime() - Date.parse(sample.sourceTime) > STALE_AFTER_MS,
				}),
			);
			if (samples.length === 0) {
				const { input } = request.value;
				unavailable.add(
					("metric" in input && input.metric) || "health_samples",
				);
			}
			for (const sample of samples) evidence.set(sample.id, sample);
			return { ...response, samples };
		},
		cited: () => ({
			evidence: [...evidence.values()],
			alerts: [...alerts.values()],
			unavailable: [...unavailable],
		}),
	};
};
