import { FamilyRecords } from "@health/contracts";
import { Me } from "@health/contracts/families";
import { ReminderHistory } from "@health/contracts/reminders";
import { RECORDS_POLL_MS } from "@/components/family/data";
import { type ApiState, familyPath, reread, useApi } from "@/lib/api";
import { loadFamilyReads, useFamily } from "@/lib/family";

/** The Home route loader: starts the reads of Home's Today box and request. */
export const loadWearerHome = loadFamilyReads((familyId) => [
	[Me, "/api/me"],
	[FamilyRecords, familyPath(familyId)],
	[ReminderHistory, familyPath(familyId, "/reminder-occurrences")],
]);

/**
 * The selected family's records. Without a family, the family list's own state explains why;
 * with none paired, null.
 */
export function useWearerRecords() {
	const { state: families, family } = useFamily();
	const path = family === null ? null : familyPath(family.id);
	const familyRecords = useApi(FamilyRecords, path, {
		pollMs: RECORDS_POLL_MS,
	});
	let records: ApiState<FamilyRecords> | null = familyRecords;
	if (families.kind !== "ready") records = families;
	else if (family === null) records = null;
	return {
		familyId: family?.id ?? null,
		familiesKind: families.kind,
		records,
		retry: () => {
			if (path !== null) reread(path);
		},
	};
}
