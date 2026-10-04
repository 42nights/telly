// Answers a family member's question with the Grokbot agent. The agent's data tools are the closed
// Fetch.ai tool set (`@health/contracts/tools`), and every tool call goes through Fetch.ai
// Agentverse to the family-scoped tool route. The server, not the model, reports which records the
// answer used and what had no records.
import type { Alert } from "@health/contracts";
import type {
	Evidence,
	FamilyAnswer,
	FamilyQuestion,
} from "@health/contracts/chat";
import { ToolRequest, type ToolResponse } from "@health/contracts/tools";
import { Data, Effect, Schema, SchemaAST } from "effect";
import { askGrokbot, type GrokbotConfig } from "./integrations/grokbot";

/** The Fetch.ai Agentverse path failed or is not configured. Carries no records or credentials. */
export class AgentToolError extends Data.TaggedError("AgentToolError")<{
	readonly reason: "unavailable" | "upstream_error";
	readonly message: string;
}> {}

/** Sends one tool request for one family through Fetch.ai Agentverse and returns the tool reply. */
export type AgentToolCaller = (
	familyId: bigint,
	request: ToolRequest,
) => Effect.Effect<ToolResponse, AgentToolError>;

// ponytail: one freshness window for every metric; per-metric windows when a metric needs one.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const instructions = (now: Date, timeZone: string) =>
	[
		"You help a person with memory loss and their family with questions about that person's health records.",
		"Use only the results of your tools. Never estimate, invent, or assume a reading, and give no diagnosis.",
		"For every value you state, give its source and its source time, and say when it is synthetic, unvalidated, or stale.",
		"When a tool returns no records, say that the data is unavailable. Missing data is never an all-clear.",
		"WHOOP data through NOOP is not connected. Never give WHOOP readings or WHOOP-based advice.",
		`The current time is ${now.toISOString()}. Write times in the ${timeZone} time zone.`,
		"Answer briefly, in the language of the question.",
	].join("\n");

/** Runs one question for one family and collects the records the agent's tool calls returned. */
export const answerQuestion = (
	config: GrokbotConfig,
	callTool: AgentToolCaller,
	familyId: bigint,
	{ question, timeZone = "UTC" }: FamilyQuestion,
	now: Date,
) => {
	const evidence = new Map<string, Evidence>();
	const alerts = new Map<string, Alert>();
	const unavailable = new Set<string>();
	const tools = ToolRequest.members.map((member) => {
		const name = member.fields.tool.literal;
		return {
			name,
			description: SchemaAST.resolveDescription(member.ast) ?? name,
			parameters: Schema.toJsonSchemaDocument(member.fields.input).schema,
			run: (input: unknown) => {
				const request = Schema.decodeUnknownOption(ToolRequest)(
					{ tool: name, input },
					{ onExcessProperty: "error" },
				);
				if (request._tag === "None")
					return Effect.succeed({
						error: "arguments do not match the tool schema",
					});
				return callTool(familyId, request.value).pipe(
					Effect.map((response) => {
						if (response.tool === "alerts") {
							for (const alert of response.alerts) alerts.set(alert.id, alert);
							return response;
						}
						const samples = response.samples.map(
							(sample): Evidence => ({
								...sample,
								stale:
									now.getTime() - Date.parse(sample.sourceTime) >
									STALE_AFTER_MS,
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
					}),
				);
			},
		};
	});
	return askGrokbot(config, {
		instructions: instructions(now, timeZone),
		question,
		tools,
	}).pipe(
		Effect.map(
			({ text, model }): FamilyAnswer => ({
				answer: text,
				evidence: [...evidence.values()],
				alerts: [...alerts.values()],
				unavailable: [...unavailable],
				model,
				answeredAt: now.toISOString(),
			}),
		),
	);
};
