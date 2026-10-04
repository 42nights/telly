import { FamilyRecords } from "@health/contracts";
import { useState } from "react";

import { RECORDS_POLL_MS } from "@/components/family/data";
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
		{ pollMs: RECORDS_POLL_MS, refreshKey: retry },
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
