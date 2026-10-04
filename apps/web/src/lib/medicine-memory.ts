// The family's medicine last-seen memory (issue #29): read it, and change it through the server.
import { MedicineMemory } from "@health/contracts/medicine-memory";

import { type ApiResult, apiRequest, familyPath, useApi } from "@/lib/api";

/** Changes the memory with one request; a `ready` reply marks the read stale, so it reads again. */
export type MedicineMemoryChange = (
	method: "PUT" | "POST",
	path: string,
	body?: unknown,
) => Promise<ApiResult<MedicineMemory>>;

/** Reads `GET /medicine-memory` for the family; each kept change makes it read again. */
export function useMedicineMemory(familyId: string | null) {
	const memory = useApi(
		MedicineMemory,
		familyId === null ? null : familyPath(familyId, "/medicine-memory"),
	);
	const change: MedicineMemoryChange = async (method, path, body) => {
		if (familyId === null)
			return { kind: "error", message: "No person is paired yet." };
		return apiRequest(
			MedicineMemory,
			familyPath(familyId, `/medicine-memory${path}`),
			{ method, body },
		);
	};
	return { memory, change };
}
