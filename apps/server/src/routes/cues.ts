import type { HealthSample } from "@health/contracts";
import { CueRequest, type HealthCue } from "@health/contracts/cues";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import { ApiFailure, decodeBody, type FamilyEnv, typedFailure } from "../http";
import { type QwenConfig, requestCue } from "../integrations/qwen";

/**
 * The family's samples for the requested ids, in request order. Unvalidated samples may drive a
 * cue: a cue is advice only, and the reply says so in `notice` (see `cueInput`).
 */
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
		return sample;
	});
};

/** The provenance of a cue, with a notice that names any unvalidated sources. */
const cueInput = (
	samples: ReadonlyArray<HealthSample>,
	sampleIds: HealthCue["input"]["sampleIds"],
): Pick<HealthCue, "input" | "notice"> => {
	const unvalidated = [
		...new Set(
			samples.filter((s) => s.quality !== "validated").map((s) => s.source),
		),
	];
	return {
		input: {
			sampleIds,
			sources: [...new Set(samples.map((s) => s.source))] as [
				string,
				...string[],
			],
			synthetic: samples.some((s) => s.synthetic),
			validated: unvalidated.length === 0,
		},
		notice:
			unvalidated.length === 0
				? null
				: `Based on unvalidated readings from ${unvalidated.join(", ")}. Advice only; it never raises an alert.`,
	};
};

/**
 * Qwen cue routes, relative to `/api/families/:familyId`: `POST /cues`. A cue is advice only; it
 * never touches thresholds or alerts. Without a configured River checkpoint every request gets
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
					baseModel: qwen.baseModel,
					checkpoint: qwen.checkpoint,
				},
				...cueInput(samples, sampleIds),
				generatedAt: new Date().toISOString(),
			} satisfies HealthCue);
		// 499: the client closed the request; nobody reads this response.
		if (Cause.hasInterruptsOnly(result.cause))
			return new Response(null, { status: 499 });
		const { _tag, message } = typedFailure(result.cause);
		console.warn("qwen cue failed", { _tag, message });
		throw new ApiFailure(
			_tag === "QwenUnavailable" ? "unavailable" : "upstream_error",
			message,
		);
	});
