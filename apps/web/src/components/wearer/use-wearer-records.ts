import { FamilyRecords } from "@health/contracts";
import { useState } from "react";

import { type ApiState, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

/**
 * The selected family's records. Without a family, the family list's own state explains why;
 * with none paired, null.
 */
export function useWearerRecords() {
	const { state: families, family } = useFamily();
	const [retry, setRetry] = useState(0);
	const familyRecords = useApi(
		FamilyRecords,
		family === null ? null : familyPath(family.id),
		{ pollMs: 30_000, refreshKey: retry },
	);
	let records: ApiState<FamilyRecords> | null = familyRecords;
	if (families.kind !== "ready") records = families;
	else if (family === null) records = null;
	return {
		familyId: family?.id ?? null,
		familiesKind: families.kind,
		records,
		retry: () => setRetry((n) => n + 1),
	};
}
