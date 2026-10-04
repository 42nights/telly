// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type { CareInstruction } from "@health/contracts/care-profile";
import type { RenderResult } from "@testing-library/react";

import { act, fireEvent, render, setupDom, within } from "../test/dom-routed";
import type { CareData } from "./data";
import { InstructionsWindow } from "./instructions-window";

setupDom();

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

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

const item = (
	id: string,
	verification: CareInstruction["verification"],
	more: Partial<CareInstruction> = {},
): CareInstruction => ({
	id,
	familyId: "f1",
	kind: "medication",
	name: `Med ${id}`,
	instruction: `Take ${id} with water`,
	times: [],
	reason: null,
	source: "pharmacy label",
	effectiveDate: "2026-10-01",
	timeZone: null,
	editedBy: OTHER,
	editedAt: "2026-10-01T09:00:00Z",
	verifiedBy: null,
	verifiedAt: null,
	verification,
	...more,
});

const list = [
	item("i1", "verified", {
		times: ["08:00", "20:00"],
		timeZone: "Europe/London",
		reason: "blood pressure",
		verifiedBy: ME,
		verifiedAt: "2026-10-02T09:00:00Z",
	}),
	item("i2", "unverified"),
	item("i3", "conflicting", { kind: "care" }),
	item("i4", "stale"),
];

const row = (view: RenderResult, name: string) => {
	const li = view.getByText(name).closest("li");
	if (li === null) throw new Error(`no row ${name}`);
	return within(li);
};

test("with nothing saved, medicines are unknown and a viewer cannot add", () => {
	const view = render(
		<InstructionsWindow
			instructions={[]}
			canEdit={false}
			care={fakeCare().care}
		/>,
	);
	expect(
		view.getByText("No instructions saved. Medicines are unknown."),
	).toBeDefined();
	expect(
		view.getByText(
			"Only verified instructions are read to the wearer. A change waits for verification.",
		),
	).toBeDefined();
	expect(view.queryByRole("form", { name: "Add an instruction" })).toBeNull();
});

test("each instruction shows its source, times, editor, and verification", () => {
	const view = render(
		<InstructionsWindow
			instructions={list}
			canEdit={false}
			care={fakeCare().care}
		/>,
	);
	const verified = row(view, "Med i1");
	expect(verified.getByText(/08:00, 20:00/)).toBeDefined();
	expect(verified.getByText(/Europe\/London/)).toBeDefined();
	expect(verified.getByText("Reason: blood pressure")).toBeDefined();
	expect(verified.getByText(/Entered by Member bbbbbb/)).toBeDefined();
	expect(verified.getByText(/verified by You on/)).toBeDefined();
	expect(verified.getByText("Verified · in effect")).toBeDefined();
	const unverified = row(view, "Med i2");
	expect(unverified.getByText(/none set/)).toBeDefined();
	expect(unverified.getByText(/time zone unknown/)).toBeDefined();
	expect(unverified.getByText("Reason: unknown")).toBeDefined();
	expect(unverified.queryByText(/verified by/)).toBeNull();
	expect(
		unverified.getByText("Not verified · not read to the wearer"),
	).toBeDefined();
	expect(row(view, "Med i3").getByText("(care)")).toBeDefined();
	expect(
		row(view, "Med i3").getByText(
			"Change not verified · the verified version stays in effect",
		),
	).toBeDefined();
	expect(
		row(view, "Med i4").getByText("Replaced by a later verified version"),
	).toBeDefined();
	expect(
		view.queryByRole("button", { name: "Verify against the source" }),
	).toBeNull();
});

test("an editor verifies only unverified or conflicting versions", async () => {
	const { care, writes } = fakeCare([null, "Only a nurse can verify."]);
	const view = render(
		<InstructionsWindow instructions={list} canEdit care={care} />,
	);
	expect(
		row(view, "Med i1").queryByRole("button", {
			name: "Verify against the source",
		}),
	).toBeNull();
	expect(
		row(view, "Med i4").queryByRole("button", {
			name: "Verify against the source",
		}),
	).toBeNull();
	await act(async () =>
		row(view, "Med i2")
			.getByRole("button", { name: "Verify against the source" })
			.click(),
	);
	expect(writes).toEqual([
		{ method: "POST", path: "/care-instructions/i2/verify", body: undefined },
	]);
	expect(view.getByText("Verified.")).toBeDefined();
	await act(async () =>
		row(view, "Med i3")
			.getByRole("button", { name: "Verify against the source" })
			.click(),
	);
	expect(writes[1]?.path).toBe("/care-instructions/i3/verify");
	expect(view.getByText("Only a nurse can verify.")).toBeDefined();
});

const fill = (view: RenderResult) => {
	const set = (label: string, value: string) =>
		fireEvent.change(view.getByLabelText(label), { target: { value } });
	set("Kind", "care");
	set("Name as written on the source", " Walk ");
	set("Dose and directions, word for word", " Walk 10 minutes ");
	set("Times", "08:00, , 18:30");
	set("Source", "discharge sheet");
	set("Effective date", "2026-10-04");
};

test("a complete form adds an unverified instruction and clears", async () => {
	const { care, writes } = fakeCare();
	const view = render(
		<InstructionsWindow instructions={[]} canEdit care={care} />,
	);
	const add = view.getByRole("button", { name: "Add" });
	expect(add.hasAttribute("disabled")).toBe(true);
	expect(view.getByLabelText("Times").getAttribute("aria-describedby")).toBe(
		"instruction-times-hint",
	);
	fill(view);
	expect(add.hasAttribute("disabled")).toBe(false);
	await act(async () =>
		fireEvent.submit(view.getByRole("form", { name: "Add an instruction" })),
	);
	expect(writes).toEqual([
		{
			method: "POST",
			path: "/care-instructions",
			body: {
				kind: "care",
				name: "Walk",
				instruction: "Walk 10 minutes",
				times: ["08:00", "18:30"],
				reason: null,
				source: "discharge sheet",
				effectiveDate: "2026-10-04",
			},
		},
	]);
	expect(view.getByRole("status").textContent).toBe(
		"Saved as not verified. Verify it against its source.",
	);
	expect(
		(view.getByLabelText("Name as written on the source") as HTMLInputElement)
			.value,
	).toBe("");
});

test("a refused add keeps the form and shows why; an incomplete form sends nothing", async () => {
	const { care, writes } = fakeCare(["No care plan grant."]);
	const view = render(
		<InstructionsWindow instructions={[]} canEdit care={care} />,
	);
	const form = view.getByRole("form", { name: "Add an instruction" });
	fireEvent.submit(form);
	expect(writes).toEqual([]);
	fill(view);
	fireEvent.change(view.getByLabelText("Reason"), {
		target: { value: " recovery " },
	});
	await act(async () => fireEvent.submit(form));
	expect(writes[0]?.body).toMatchObject({ reason: "recovery" });
	expect(view.getByRole("status").textContent).toBe("No care plan grant.");
	expect(
		(view.getByLabelText("Name as written on the source") as HTMLInputElement)
			.value,
	).toBe(" Walk ");
});
