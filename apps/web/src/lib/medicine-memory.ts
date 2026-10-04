// The family's medicine last-seen memory (issue #29): read it, and change it through the server.
import { MedicineMemory } from "@health/contracts/medicine-memory";
import { useState } from "react";

import { type ApiResult, apiRequest, familyPath, useApi } from "@/lib/api";

/** Changes the memory with one request; a `ready` reply also re-reads it. */
export type MedicineMemoryChange = (
	method: "PUT" | "POST",
	path: string,
	body?: unknown,
) => Promise<ApiResult<MedicineMemory>>;

/** Reads `GET /medicine-memory` for the family and re-reads it after each change. */
export function useMedicineMemory(familyId: string | null) {
	const [refreshKey, setRefreshKey] = useState(0);
	const memory = useApi(
		MedicineMemory,
		familyId === null ? null : familyPath(familyId, "/medicine-memory"),
		{ refreshKey },
	);
	const change: MedicineMemoryChange = async (method, path, body) => {
		if (familyId === null)
			return { kind: "error", message: "No person is paired yet." };
		const result = await apiRequest(
			MedicineMemory,
			familyPath(familyId, `/medicine-memory${path}`),
			{ method, body },
		);
		if (result.kind === "ready") setRefreshKey((key) => key + 1);
		return result;
	};
	return { memory, change };
}
