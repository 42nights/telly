import type { HealthSample } from "@health/contracts";
import { CueRequest, type HealthCue } from "@health/contracts/cues";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import { type QwenConfig, requestCue } from "../integrations/qwen";

/** The family's validated samples for the requested ids, in request order. */
export const pickSamples = (
	samples: ReadonlyArray<HealthSample>,
	familyId: string,
	ids: ReadonlyArray<string>,
): ReadonlyArray<HealthSample> => {
	const own = new Map(
		samples.filter((s) => s.familyId === familyId).map((s) => [s.id, s]),
	);
	return ids.map((id) => {
		const sample = own.get(id);
		if (sample === undefined)
			throw new ApiFailure(
				"invalid_request",
				`Sample ${id} is not in this family`,
			);
		if (sample.quality !== "validated")
			throw new ApiFailure(
				"invalid_request",
				`Sample ${id} is unvalidated; only validated samples can drive a cue`,
			);
		return sample;
	});
};

/**
 * Qwen cue routes, relative to `/api/families/:familyId`: `POST /cues`. A cue is advice only; it
 * never touches thresholds or alerts. Without a configured deployment every request gets
 * `unavailable`, never a canned cue.
 */
export const cueRoutes = (qwen: QwenConfig | undefined) =>
	new Hono<FamilyEnv>().post("/cues", async (c) => {
		if (qwen === undefined)
			throw new ApiFailure("unavailable", "Qwen inference is not configured");
		const { sampleIds } = await decodeBody(c, CueRequest);
		const samples = pickSamples(
			readFamilyRecords(c.var.db).samples,
			c.var.familyId.toString(),
			sampleIds,
		);

		// The request signal interrupts the provider call when the client disconnects.
		const result = await Effect.runPromiseExit(requestCue(qwen, samples), {
			signal: c.req.raw.signal,
		});
		if (Exit.isSuccess(result))
			return c.json({
				...result.value,
				format: "health-cue-v1",
				model: {
					provider: "river",
					deployment: qwen.deployment,
					checkpoint: qwen.checkpoint,
				},
				input: {
					sampleIds,
					sources: [...new Set(samples.map((s) => s.source))] as [
						string,
						...string[],
					],
					synthetic: samples.some((s) => s.synthetic),
				},
				generatedAt: new Date().toISOString(),
			} satisfies HealthCue);
		// 499: the client closed the request; nobody reads this response.
		if (Cause.hasInterruptsOnly(result.cause))
			return new Response(null, { status: 499 });
		const failure = Cause.findErrorOption(result.cause);
		if (failure._tag === "None") throw Cause.squash(result.cause);
		const { _tag, message } = failure.value;
		console.warn("qwen cue failed", { _tag, message });
		throw new ApiFailure(
			_tag === "QwenUnavailable" ? "unavailable" : "upstream_error",
			message,
		);
	});
