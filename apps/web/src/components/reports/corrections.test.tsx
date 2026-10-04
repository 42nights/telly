import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { ReportMarker } from "@health/contracts/reports";
import { useState } from "react";
import { fireEvent, installDom, render, within } from "../test/dom";

import { CorrectionForm } from "./corrections";
import { draftOf, type FieldDraft } from "./logic";
import type { ReportSheetState } from "./use-report-sheet";

installDom();

const sample = (metric: string, value: number, unit: string) => ({
	id: metric,
	familyId: "1",
	metric,
	value,
	unit,
	sourceTime: "2026-03-05T14:30:00Z",
	receivedAt: "2026-03-05T14:31:00Z",
	source: "watch",
	synthetic: false,
	quality: "validated" as const,
});

const markers: ReportMarker[] = [
	{ metric: "heart_rate", sample: sample("heart_rate", 72, "bpm") },
	{ metric: "blood_oxygen", sample: null },
	{ metric: "hrv", sample: sample("hrv", 40, "ms") },
];

const blank = draftOf({
	patientName: null,
	dateOfBirth: null,
	patientId: null,
	physician: null,
	hospital: null,
	notes: null,
	observations: null,
	questions: null,
	corrections: [],
});

const noop = async () => {};

/** Renders the form with a sheet whose draft lives in state; `saved` receives each new draft. */
function Harness({
	reviewed = false,
	initial = blank,
	list = markers,
	saved,
}: {
	reviewed?: boolean;
	initial?: FieldDraft;
	list?: readonly ReportMarker[];
	saved?: FieldDraft[];
}) {
	const [draft, setDraft] = useState(initial);
	const sheet: ReportSheetState = {
		reviewed,
		draft,
		setDraft: (next) => {
			saved?.push(next);
			setDraft(next);
		},
		errors: {},
		valid: true,
		dirty: false,
		busy: null,
		confirmed: false,
		setConfirmed: () => {},
		sendFailure: null,
		save: noop,
		review: noop,
		submit: noop,
		email: noop,
		status: "",
	};
	return <CorrectionForm sheet={sheet} markers={list} />;
}

const fill = (value: string, reason: string) => {
	const page = within(document.body);
	fireEvent.change(page.getByLabelText(/Correct value/), {
		target: { value },
	});
	fireEvent.change(page.getByLabelText("Reason"), {
		target: { value: reason },
	});
	fireEvent.click(page.getByRole("button", { name: "Add correction" }));
};

describe("CorrectionForm", () => {
	test("offers only measured markers, with their source value and unit", () => {
		const view = render(<Harness />);
		const options = view
			.getAllByRole("option")
			.map((option) => option.textContent);
		expect(options).toEqual(["Heart rate · 72 bpm", "HRV · 40 ms"]);
		expect(view.getByText("Correct value (bpm)")).toBeDefined();
	});

	test("adds a correction for the chosen marker and clears the boxes", () => {
		const saved: FieldDraft[] = [];
		const view = render(<Harness saved={saved} />);
		fireEvent.change(view.getByLabelText("Marker"), {
			target: { value: "hrv" },
		});
		expect(view.getByText("Correct value (ms)")).toBeDefined();
		fill("45.5", "  Typing error ");
		expect(saved.at(-1)?.corrections).toEqual([
			{ metric: "hrv", value: 45.5, reason: "Typing error" },
		]);
		expect(view.queryByRole("alert")).toBeNull();
		// The corrected marker is no longer offered; the boxes are empty again.
		expect(
			view.getAllByRole("option").map((option) => option.textContent),
		).toEqual(["Heart rate · 72 bpm"]);
		expect(view.getByLabelText("Reason")).toHaveProperty("value", "");
		expect(view.getByLabelText(/Correct value/)).toHaveProperty("value", "");
	});

	test("an empty value or reason is refused with a message, then cleared on success", () => {
		const saved: FieldDraft[] = [];
		const view = render(<Harness saved={saved} />);
		fill("", "Typo");
		expect(view.getByRole("alert").textContent).toBe(
			"Enter the correct number and a reason (up to 200 characters).",
		);
		fill("80", "   ");
		expect(view.getByRole("alert")).toBeDefined();
		fill("80", "x".repeat(201));
		expect(view.getByRole("alert")).toBeDefined();
		expect(saved).toEqual([]);
		fill("0", "Sensor off");
		expect(view.queryByRole("alert")).toBeNull();
		expect(saved.at(-1)?.corrections).toEqual([
			{ metric: "heart_rate", value: 0, reason: "Sensor off" },
		]);
	});

	test("keeps earlier corrections when adding another", () => {
		const saved: FieldDraft[] = [];
		const earlier = { metric: "heart_rate", value: 70, reason: "Typo" };
		const view = render(
			<Harness saved={saved} initial={{ ...blank, corrections: [earlier] }} />,
		);
		expect(
			view.getAllByRole("option").map((option) => option.textContent),
		).toEqual(["HRV · 40 ms"]);
		fill("42", "Wrong strap");
		expect(saved.at(-1)?.corrections).toEqual([
			earlier,
			{ metric: "hrv", value: 42, reason: "Wrong strap" },
		]);
		// Every measured marker is corrected: nothing is left to offer.
		expect(view.container.innerHTML).toBe("");
	});

	test("shows nothing for a reviewed report", () => {
		const view = render(<Harness reviewed />);
		expect(view.container.innerHTML).toBe("");
	});

	test("shows nothing when no marker has a sample", () => {
		const view = render(
			<Harness list={[{ metric: "blood_oxygen", sample: null }]} />,
		);
		expect(view.container.innerHTML).toBe("");
	});
});
