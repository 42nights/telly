import { ApiError } from "@health/contracts";
import { type ToolRequest, ToolResponse } from "@health/contracts/tools";
import { Exit, Schema } from "effect";
import { ApiFailure } from "../http";

export type FetchAgentConfig = {
	readonly bridgeUrl: string;
	readonly bridgeToken: string;
};

// The bridge waits up to 30 s for Agentverse; allow it to answer first.
const TIMEOUT_MS = 40_000;

const Envelope = Schema.Struct({
	family_id: Schema.String,
	status: Schema.Int,
	body: Schema.Unknown,
});

const upstream = () =>
	new ApiFailure("upstream_error", "The Fetch.ai agent gave an invalid answer");

/**
 * Runs one agent tool through Fetch.ai Agentverse: this server -> local bridge uAgent (HTTP) ->
 * Agentverse mailbox -> worker uAgent -> `POST /api/families/:familyId/tools`. The result holds
 * only the granted family's records. No retries and no direct fallback.
 */
export const callAgentTool = async (
	config: FetchAgentConfig | undefined,
	familyId: bigint | string,
	request: ToolRequest,
	signal?: AbortSignal,
): Promise<ToolResponse> => {
	if (!config)
		throw new ApiFailure(
			"unavailable",
			"Fetch.ai Agentverse is not configured",
		);
	const family_id = familyId.toString();
	let response: Response;
	try {
		response = await fetch(`${config.bridgeUrl.replace(/\/$/, "")}/tool-call`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: config.bridgeToken, family_id, request }),
			signal: AbortSignal.any([
				AbortSignal.timeout(TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});
	} catch {
		throw new ApiFailure("unavailable", "The Fetch.ai bridge is not reachable");
	}
	if (response.status !== 200) throw upstream();
	const raw: unknown = await response.json().catch(() => undefined);
	const envelope = Schema.decodeUnknownExit(Envelope)(raw);
	if (Exit.isFailure(envelope) || envelope.value.family_id !== family_id)
		throw upstream();
	const { status, body } = envelope.value;
	if (status === 200) {
		const result = Schema.decodeUnknownExit(ToolResponse)(body);
		if (Exit.isFailure(result) || result.value.tool !== request.tool)
			throw upstream();
		return result.value;
	}
	const error = Schema.decodeUnknownExit(ApiError)(body);
	if (Exit.isFailure(error)) throw upstream();
	throw new ApiFailure(error.value.error, error.value.message);
};
