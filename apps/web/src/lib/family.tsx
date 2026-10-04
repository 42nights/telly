// The family the screens show. The server returns the caller's families; the app selects one and
// remembers it on this device. A new account has no family, so `NewFamilyBar` lets it create its
// first one; every other screen needs a family. Adding more people is still manual pairing.
import { Family, type Family as FamilyRow } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import { Tip } from "@/components/win95";

import { type ApiState, apiRequest, useApi } from "./api";

const KEY = "telly.family";

type FamilyContext = {
	readonly state: ApiState<FamilyList>;
	/** The selected family, or null while loading, on failure, or when the caller has none. */
	readonly family: FamilyRow | null;
	readonly select: (familyId: string) => void;
	/** Reads the family list again (after a new family is created). */
	readonly reload: () => void;
};

const Context = createContext<FamilyContext | null>(null);

export function FamilyProvider({ children }: { children: ReactNode }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const state = useApi(FamilyList, "/api/families", { refreshKey });
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
	const reload = () => setRefreshKey((key) => key + 1);
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

/** Shown only to a signed-in caller with no family yet: creates their first family. */
export function NewFamilyBar() {
	const { state, select, reload } = useFamily();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (state.kind !== "ready" || state.value.families.length > 0) return null;
	const create = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const result = await apiRequest(Family, "/api/families", {
			method: "POST",
			body: { name: name.trim() },
		});
		setBusy(false);
		if (result.kind === "ready") {
			select(result.value.id);
			reload();
		} else
			setError(
				result.kind === "signed_out"
					? "Sign in again to create a family."
					: result.message,
			);
	};
	return (
		<form
			onSubmit={create}
			className="flex flex-wrap items-center gap-2 border-b bg-card p-2 text-sm"
		>
			<label htmlFor="new-family-name">
				You have no family yet. Name it to start:
			</label>
			<input
				id="new-family-name"
				className="win95-inset win95-field h-11 min-w-48 bg-card px-2 text-base"
				value={name}
				onChange={(event) => setName(event.target.value)}
				placeholder="For example, Rivera family"
				required
			/>
			<Button
				type="submit"
				className="win95-primary h-11 px-4"
				disabled={busy || name.trim() === ""}
			>
				{busy ? "Creating…" : "Create family"}
			</Button>
			{error !== null && (
				<p role="alert">Could not create the family. {error}</p>
			)}
		</form>
	);
}
