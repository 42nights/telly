import { FamilyRecords } from "@health/contracts";
import { CareInstructions } from "@health/contracts/care-profile";
import { Me } from "@health/contracts/families";
import { MedicineMemory } from "@health/contracts/medicine-memory";
import { ReminderHistory } from "@health/contracts/reminders";
import { RECORDS_POLL_MS } from "@/components/family/data";
import { type ApiState, familyPath, reread, useApi } from "@/lib/api";
import { loadFamilyReads, useFamily } from "@/lib/family";

/** The Home route loader: starts the wearer's records, reminders, and medicine reads. */
export const loadWearerHome = loadFamilyReads((familyId) => [
	[Me, "/api/me"],
	[FamilyRecords, familyPath(familyId)],
	[ReminderHistory, familyPath(familyId, "/reminder-occurrences")],
	[CareInstructions, familyPath(familyId, "/care-instructions")],
	[MedicineMemory, familyPath(familyId, "/medicine-memory")],
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
