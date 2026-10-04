// Reads and writes of the care plan screen (#26). Every write goes to the server, which checks the
// caller's care grants; a kept write marks the reads it changed stale, so the screen never shows a
// change the server did not keep.
import {
	CareAccess,
	CareInstructions,
	CareProfileRecord,
	CarePrompt,
} from "@health/contracts/care-profile";
import { Me } from "@health/contracts/families";

import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";

export type CareData = {
	readonly me: string | null;
	readonly access: ApiState<CareAccess>;
	readonly profile: ApiState<CareProfileRecord>;
	readonly instructions: ApiState<CareInstructions>;
	readonly prompt: ApiState<CarePrompt>;
	/** Sends one write; resolves to the server's refusal, or `null` when it was kept. */
	readonly write: (
		method: "PUT" | "POST",
		path: string,
		body?: unknown,
	) => Promise<string | null>;
};

/** The reads of `useCare`, which the care plan route loaders start ahead of the screen. */
export const careReads = (familyId: string) =>
	[
		[Me, "/api/me"],
		[CareAccess, familyPath(familyId, "/care-access")],
		[CareProfileRecord, familyPath(familyId, "/care-profile")],
		[CareInstructions, familyPath(familyId, "/care-instructions")],
		[CarePrompt, familyPath(familyId, "/care-profile/prompt")],
	] as const;

export function useCare(familyId: string): CareData {
	const path = (sub: string) => familyPath(familyId, sub);
	const me = useApi(Me, "/api/me");
	return {
		me: me.kind === "ready" ? me.value.identity : null,
		access: useApi(CareAccess, path("/care-access")),
		profile: useApi(CareProfileRecord, path("/care-profile")),
		instructions: useApi(CareInstructions, path("/care-instructions")),
		prompt: useApi(CarePrompt, path("/care-profile/prompt")),
		write: async (method, sub, body) => {
			const result = await apiRequest(null, path(sub), { method, body });
			if (result.kind === "ready") return null;
			return result.kind === "signed_out"
				? "Sign in again to save."
				: result.message;
		},
	};
}
