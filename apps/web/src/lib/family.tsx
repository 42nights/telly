// The family the screens show. The server returns the caller's families; the app selects one and
// remembers it on this device. The demo supports one person per family, paired manually; there is
// no onboarding yet, so the picker shows that limit instead of an add button that does nothing.
import type { Family } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
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

type FamilyContext = {
	readonly state: ApiState<FamilyList>;
	/** The selected family, or null while loading, on failure, or when the caller has none. */
	readonly family: Family | null;
	readonly select: (familyId: string) => void;
};

const Context = createContext<FamilyContext | null>(null);

export function FamilyProvider({ children }: { children: ReactNode }) {
	const state = useApi(FamilyList, "/api/families");
	const [remembered, setRemembered] = useState<string | null>(null);
	useEffect(() => setRemembered(localStorage.getItem(KEY)), []);
	// The remembered family while it is still listed, otherwise the first.
	const family =
		state.kind === "ready"
			? (state.value.families.find((option) => option.id === remembered) ??
				state.value.families[0] ??
				null)
			: null;
	const select = (familyId: string) => {
		localStorage.setItem(KEY, familyId);
		setRemembered(familyId);
	};
	return (
		<Context.Provider value={{ state, family, select }}>
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

/** Win95 combo box for the person the screen shows. */
export function PersonPicker({ className }: { className?: string }) {
	const { state, family, select } = useFamily();
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
				disabled={families.length === 0}
				onChange={(event) => select(event.target.value)}
			>
				{families.length === 0 && <option value="">No person yet</option>}
				{families.map((option) => (
					<option key={option.id} value={option.id}>
						{option.name}
					</option>
				))}
				<option disabled value="add">
					Add a person — manual pairing only
				</option>
			</select>
			<Tip text="This demo supports one person. People are paired manually; there is no onboarding yet." />
		</span>
	);
}
