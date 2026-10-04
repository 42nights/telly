// The family the screens show. The server returns the caller's families; the app selects one. The
// person picked in this tab is in the address (`?person=<family id>`, kept by the root route), so
// tabs do not change each other's person and a link opens the same person. The last pick is also
// remembered on this device as the default. A new person gets their own family through onboarding.
import type { Family } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import { Tip } from "@/components/win95";

import { type ApiState, useApi } from "./api";

const KEY = "telly.family";

type Listed = FamilyList["families"][number];

/**
 * The family to show: one picked in this tab; else the one remembered on this device, unless it has
 * no real data while another family does; else the family with the newest real data; else the first.
 */
export const chooseFamily = (
	families: readonly Listed[],
	picked: string | null,
	remembered: string | null,
): Listed | null => {
	const live = families
		.filter((f) => f.newestSampleAt)
		.sort((a, b) =>
			(b.newestSampleAt ?? "").localeCompare(a.newestSampleAt ?? ""),
		)[0];
	const kept = families.find((f) => f.id === remembered);
	return (
		families.find((f) => f.id === picked) ??
		(kept !== undefined && (kept.newestSampleAt || live === undefined)
			? kept
			: undefined) ??
		live ??
		families[0] ??
		null
	);
};

type FamilyContext = {
	readonly state: ApiState<FamilyList>;
	/** The selected family, or null while loading, on failure, or when the caller has none. */
	readonly family: Family | null;
	readonly select: (familyId: string) => void;
	/** Reads the list again; it shows loading until the new reply, so a new family is never missing. */
	readonly reload: () => void;
};

const Context = createContext<FamilyContext | null>(null);

/** The person picked in this tab and how to pick another. The root route keeps it in the address. */
export type PersonPick = {
	readonly picked: string | null;
	readonly pick: (familyId: string) => void;
};

export function FamilyProvider({
	children,
	person,
}: {
	children: ReactNode;
	/** Without it (tests outside a router), the pick lives in this provider only. */
	person?: PersonPick;
}) {
	const [reloadAt, setReloadAt] = useState(0);
	const read = useApi(FamilyList, "/api/families", { refreshKey: reloadAt });
	const state: ApiState<FamilyList> =
		read.kind === "ready" && read.at <= reloadAt ? { kind: "loading" } : read;
	const [remembered, setRemembered] = useState<string | null>(null);
	const [localPick, setLocalPick] = useState<string | null>(null);
	useEffect(() => setRemembered(localStorage.getItem(KEY)), []);
	const picked = person ? person.picked : localPick;
	const family =
		state.kind === "ready"
			? chooseFamily(state.value.families, picked, remembered)
			: null;
	const select = (familyId: string) => {
		localStorage.setItem(KEY, familyId);
		setRemembered(familyId);
		(person?.pick ?? setLocalPick)(familyId);
	};
	const reload = () => setReloadAt(Date.now());
	return (
		<Context.Provider value={{ state, family, select, reload }}>
			{children}
		</Context.Provider>
	);
}

export function useFamily(): FamilyContext {
	const context = useContext(Context);
	if (context === null)
		throw new Error("useFamily must be used inside FamilyProvider");
	return context;
}

/** Win95 combo box for the person the screen shows. "Add a person" opens onboarding. */
export function PersonPicker({ className }: { className?: string }) {
	const { state, family, select } = useFamily();
	const navigate = useNavigate();
	const families = state.kind === "ready" ? state.value.families : [];
	return (
		<span className={`flex items-center gap-1.5 ${className ?? ""}`}>
			<label htmlFor="person-picker" className="text-sm">
				Person
			</label>
			<select
				id="person-picker"
				className="win95-inset win95-field h-11 min-w-40 bg-card px-2 text-sm"
				value={family?.id ?? ""}
				onChange={(event) =>
					event.target.value === "add"
						? void navigate({ to: "/welcome" })
						: select(event.target.value)
				}
			>
				{families.length === 0 && <option value="">No person yet</option>}
				{families.map((option) => (
					<option key={option.id} value={option.id}>
						{option.name}
					</option>
				))}
				<option value="add">Add a person…</option>
			</select>
			<Tip text="Each person has their own family. Add a person to set up another one." />
		</span>
	);
}
