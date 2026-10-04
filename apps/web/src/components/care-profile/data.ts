// Reads and writes of the care plan screen (#26). Every write goes to the server, which checks the
// caller's care grants; after a write the screen reads everything again, so it never shows a change
// the server did not keep.
import {
	CareAccess,
	CareInstructions,
	CareProfileRecord,
	CarePrompt,
} from "@health/contracts/care-profile";
import { Me } from "@health/contracts/families";
import { useState } from "react";

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

export function useCare(familyId: string): CareData {
	const [refreshKey, setRefreshKey] = useState(0);
	const path = (sub: string) => familyPath(familyId, sub);
	const options = { refreshKey };
	const me = useApi(Me, "/api/me");
	return {
		me: me.kind === "ready" ? me.value.identity : null,
		access: useApi(CareAccess, path("/care-access"), options),
		profile: useApi(CareProfileRecord, path("/care-profile"), options),
		instructions: useApi(CareInstructions, path("/care-instructions"), options),
		prompt: useApi(CarePrompt, path("/care-profile/prompt"), options),
		write: async (method, sub, body) => {
			const result = await apiRequest(null, path(sub), { method, body });
			setRefreshKey((key) => key + 1);
			if (result.kind === "ready") return null;
			return result.kind === "signed_out"
				? "Sign in again to save."
				: result.message;
		},
	};
}
