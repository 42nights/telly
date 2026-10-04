// The family the screens show. The server returns the caller's families; the app selects one and
// remembers it on this device. A new person gets their own family through onboarding (/welcome).
import type { Family } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import type { QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Schema } from "effect";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import { Tip } from "@/components/win95";

import { type ApiState, apiQuery, useApi } from "./api";

const KEY = "telly.family";

type FamilyContext = {
	readonly state: ApiState<FamilyList>;
	/** The selected family, or null while loading, on failure, or when the caller has none. */
	readonly family: Family | null;
	readonly select: (familyId: string) => void;
};

const Context = createContext<FamilyContext | null>(null);

/** The remembered family while it is still listed, otherwise the first. */
const pick = (list: FamilyList, remembered: string | null) =>
	list.families.find((option) => option.id === remembered) ??
	list.families[0] ??
	null;

export function FamilyProvider({ children }: { children: ReactNode }) {
	const state = useApi(FamilyList, "/api/families");
	const [remembered, setRemembered] = useState<string | null>(null);
	useEffect(() => setRemembered(localStorage.getItem(KEY)), []);
	const family = state.kind === "ready" ? pick(state.value, remembered) : null;
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

/** One read of a screen: its contract and its path. */
type Read = readonly [schema: Schema.Decoder<unknown>, path: string];

const warm = async (
	queryClient: QueryClient,
	reads: (familyId: string) => readonly Read[],
) => {
	const list = await queryClient.ensureQueryData(
		apiQuery(FamilyList, "/api/families"),
	);
	const family = pick(list, localStorage.getItem(KEY));
	if (family === null) return;
	await Promise.all(
		reads(family.id).map(([schema, path]) =>
			queryClient.ensureQueryData(apiQuery(schema, path)),
		),
	);
};

/**
 * A route loader that starts a screen's `reads` for the selected family. The router preloads on
 * intent, so a hover or tap on a menu item starts the reads before the screen opens. The loader
 * does not wait for them: the screen opens at once, with cached data or its loading state, and it
 * shows any failure itself.
 */
export const loadFamilyReads =
	(reads: (familyId: string) => readonly Read[]) =>
	({ context }: { context: { queryClient: QueryClient } }) => {
		warm(context.queryClient, reads).catch(() => {});
	};

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
