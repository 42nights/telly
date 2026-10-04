// One member's medicine last-seen memory (issues #29, #291): read it, change it through the server,
// and choose whose it is. Each family member has their own medicines and places.
import { MedicineMemory } from "@health/contracts/medicine-memory";
import { useEffect, useState } from "react";

import { Tip } from "@/components/win95";
import {
	type ApiResult,
	type ApiState,
	apiRequest,
	familyPath,
	useApi,
} from "@/lib/api";
import { memberLabel } from "@/lib/members";
import { freshRead } from "@/lib/query";
import { useView } from "@/lib/view";

const KEY = "telly.medicine-person";

/** Changes the memory with one request; a `ready` reply marks the read stale, so it reads again. */
export type MedicineMemoryChange = (
	method: "PUT" | "POST",
	path: string,
	body?: unknown,
) => Promise<ApiResult<MedicineMemory>>;

/**
 * Reads `GET /medicine-memory` for one member of the family; each kept change makes it read again.
 * `person` null is the signed-in member.
 */
export function useMedicineMemory(
	familyId: string | null,
	person: string | null = null,
) {
	const query = person === null ? "" : `?person=${person}`;
	const memory = useApi(
		MedicineMemory,
		familyId === null ? null : familyPath(familyId, `/medicine-memory${query}`),
	);
	const change: MedicineMemoryChange = async (method, path, body) => {
		if (familyId === null)
			return { kind: "error", message: "No person is paired yet." };
		return apiRequest(
			MedicineMemory,
			familyPath(familyId, `/medicine-memory${path}${query}`),
			{ method, body },
		);
	};
	return { memory, change };
}

/**
 * The memory of the member last chosen on this device for this family, or the signed-in member's.
 * A member the caller may no longer open falls back to the signed-in member. The wearer view
 * always shows the signed-in member's own.
 */
export function useChosenMedicineMemory(familyId: string | null) {
	const [, reread] = useState(0);
	const wearer = useView() === "wearer";
	const key = `${KEY}.${familyId}`;
	const person = familyId === null || wearer ? null : localStorage.getItem(key);
	const read = useMedicineMemory(familyId, person);
	const lost = read.memory.kind === "forbidden" && person !== null;
	useEffect(() => {
		if (!lost) return;
		localStorage.removeItem(key);
		reread((n) => n + 1);
	}, [lost, key]);
	const choose = (next: string) => {
		// Another member's medicines show only once read now, never from an earlier visit.
		if (familyId !== null) freshRead(familyPath(familyId, "/medicine-memory"));
		localStorage.setItem(key, next);
		reread((n) => n + 1);
	};
	return { ...read, choose };
}

/** Win95 combo box for whose medicines and places the screen shows, as the Person picker. */
export function WhoseMedicinesPicker({
	memory,
	choose,
	className,
}: {
	memory: ApiState<MedicineMemory>;
	choose: (person: string) => void;
	className?: string;
}) {
	// Keeps the last list while another member's memory loads, so the picker does not jump.
	const [shown, setShown] = useState<MedicineMemory | null>(null);
	const wearer = useView() === "wearer";
	const ready = memory.kind === "ready" ? memory.value : null;
	useEffect(() => {
		if (ready !== null) setShown(ready);
	}, [ready]);
	const value = ready ?? shown;
	if (value === null || wearer) return null;
	const me = value.people[0] ?? null;
	return (
		<span className={`flex items-center gap-1.5 ${className ?? ""}`}>
			<label htmlFor="whose-medicines" className="text-sm">
				Whose medicines?
			</label>
			<select
				id="whose-medicines"
				className="win95-inset win95-field h-11 min-w-40 bg-card px-2 text-sm"
				disabled={ready === null}
				value={value.personId}
				onChange={(event) => choose(event.target.value)}
			>
				{value.people.map((person) => (
					<option key={person} value={person}>
						{memberLabel(person, me)}
					</option>
				))}
			</select>
			<Tip text="Each family member has their own medicines and places. Family admins and caregivers can open every member's; everyone else sees only their own." />
		</span>
	);
}
