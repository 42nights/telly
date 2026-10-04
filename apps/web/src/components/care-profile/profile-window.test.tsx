// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	CareProfile,
	CareProfileRecord,
} from "@health/contracts/care-profile";
import type { RenderResult } from "@testing-library/react";

import { act, fireEvent, render, setupDom } from "../test/dom-routed";
import type { CareData } from "./data";
import { ProfileWindow } from "./profile-window";

setupDom();

const ME = "a".repeat(64);

/** A care plan whose writes are recorded and answered from `replies` (`null` = kept). */
const fakeCare = (replies: (string | null)[] = []) => {
	const writes: { method: string; path: string; body: unknown }[] = [];
	const care: CareData = {
		me: ME,
		access: { kind: "loading" },
		profile: { kind: "loading" },
		instructions: { kind: "loading" },
		prompt: { kind: "loading" },
		write: async (method, path, body) => {
			writes.push({ method, path, body });
			return replies.shift() ?? null;
		},
	};
	return { care, writes };
};

const unknown: CareProfile = {
	preferredName: null,
	language: null,
	timeZone: null,
	accessibilityNeeds: null,
	diagnoses: null,
	allergies: null,
	dietaryRestrictions: null,
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: null,
	contacts: null,
	familiarDestinations: null,
	devices: null,
	declinedPrompts: [],
};

const unsaved: CareProfileRecord = {
	familyId: "f1",
	profile: unknown,
	editedBy: null,
	editedAt: null,
	history: [],
};

const saved: CareProfileRecord = {
	familyId: "f1",
	profile: { ...unknown, preferredName: "Synthetic Sam", allergies: [] },
	editedBy: ME,
	editedAt: "2026-10-02T09:00:00Z",
	history: [
		{ editedBy: ME, editedAt: "2026-10-02T09:00:00Z" },
		{ editedBy: ME, editedAt: "2026-10-01T09:00:00Z" },
	],
};

const value = (view: RenderResult, label: string) =>
	(view.getByLabelText(label) as HTMLInputElement).value;

test("before the first save every fact is unknown, and a viewer cannot edit", () => {
	const view = render(
		<ProfileWindow record={unsaved} canEdit={false} care={fakeCare().care} />,
	);
	expect(view.getByText("Not saved yet: every fact is unknown.")).toBeDefined();
	expect(value(view, "Preferred name")).toBe("");
	expect(view.getByLabelText("Preferred name").hasAttribute("readonly")).toBe(
		true,
	);
	expect(view.getByLabelText("Routines").getAttribute("aria-describedby")).toBe(
		"care-routines-hint",
	);
	expect(
		view.getByText("Your access does not include editing the care plan."),
	).toBeDefined();
	expect(view.queryByRole("button", { name: "Save profile" })).toBeNull();
});

test("a saved profile shows its facts, who saved it, and how many versions", () => {
	const view = render(
		<ProfileWindow record={saved} canEdit care={fakeCare().care} />,
	);
	expect(view.getByText(/^Saved by You on .* · 2 version\(s\)$/)).toBeDefined();
	expect(value(view, "Preferred name")).toBe("Synthetic Sam");
	expect(value(view, "Allergies")).toBe("none");
	expect(value(view, "Conditions (diagnoses)")).toBe("");
});

test("an editor saves the whole profile; a refusal shows why", async () => {
	const { care, writes } = fakeCare([null, "No care plan grant."]);
	const view = render(<ProfileWindow record={saved} canEdit care={care} />);
	fireEvent.change(view.getByLabelText("Language"), {
		target: { value: " Welsh " },
	});
	fireEvent.change(view.getByLabelText("Contacts, in call order"), {
		target: { value: "Synthetic Ana; daughter; 555-0100" },
	});
	const form = view.getByRole("form", { name: "Care profile" });
	await act(async () => fireEvent.submit(form));
	expect(writes).toEqual([
		{
			method: "PUT",
			path: "/care-profile",
			body: {
				...saved.profile,
				language: "Welsh",
				contacts: [
					{
						name: "Synthetic Ana",
						relationship: "daughter",
						phone: "555-0100",
					},
				],
			},
		},
	]);
	expect(view.getByText("Saved.")).toBeDefined();
	await act(async () => fireEvent.submit(form));
	expect(view.getByText("No care plan grant.")).toBeDefined();
});

test("a box that does not match its format blocks the save", () => {
	const { care, writes } = fakeCare();
	const view = render(<ProfileWindow record={saved} canEdit care={care} />);
	fireEvent.change(view.getByLabelText("Routines"), {
		target: { value: "walk; 25:00" },
	});
	expect(view.getByRole("alert").textContent).toBe(
		"A box does not match its format.",
	);
	expect(
		view.getByRole("button", { name: "Save profile" }).hasAttribute("disabled"),
	).toBe(true);
	fireEvent.submit(view.getByRole("form", { name: "Care profile" }));
	expect(writes).toEqual([]);
});
