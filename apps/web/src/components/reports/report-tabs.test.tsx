import "../test/setup";

import { describe, expect, mock, test } from "bun:test";
import type {
	Report,
	ReportEmail,
	ReportMarker,
} from "@health/contracts/reports";
import type { ReactNode } from "react";
import type { ApiFailure } from "@/lib/api";
import { fireEvent, installDom, render, serve, waitFor } from "../test/dom";

import { formatTime } from "./logic";
import {
	DailyTab,
	MarkersTab,
	NotesTab,
	PatientTab,
	SendDialog,
	SendTab,
} from "./report-tabs";
import { type ReportSheetState, useReportSheet } from "./use-report-sheet";

installDom();

const REVIEWED_AT = "2026-10-02T10:00:00.000Z";
const REVIEW = { reviewedBy: "me", reviewedAt: REVIEWED_AT };

const marker = (
	metric: string,
	sample: Partial<NonNullable<ReportMarker["sample"]>> | null = {},
): ReportMarker => ({
	metric,
	sample:
		sample === null
			? null
			: {
					id: `s-${metric}`,
					familyId: "1",
					metric,
					value: 72,
					unit: "bpm",
					sourceTime: "2026-10-01T08:00:00.000Z",
					receivedAt: "2026-10-01T08:01:00.000Z",
					source: "Watch",
					synthetic: false,
					quality: "validated",
					...sample,
				},
});

const report = (over: Partial<Report> = {}): Report => ({
	id: "r1",
	familyId: "1",
	createdBy: "me",
	createdAt: "2026-10-01T09:00:00.000Z",
	email: null,
	markers: [],
	meals: null,
	unresolved: null,
	fields: {
		patientName: "Ada",
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: null,
		observations: null,
		questions: null,
		corrections: [],
	},
	review: null,
	...over,
});

/** Renders tab content with the real sheet state of `value`; `patch` replaces parts of it. */
function Sheet({
	value,
	tab,
	patch = {},
}: {
	value: Report;
	tab: (sheet: ReportSheetState) => ReactNode;
	patch?: Partial<ReportSheetState>;
}) {
	const sheet = useReportSheet(value, "1", () => {}, null);
	return <>{tab({ ...sheet, ...patch })}</>;
}

describe("PatientTab", () => {
	test("shows the saved fields and saves an edit", async () => {
		const calls = serve({
			"POST /api/families/1/reports/r1/fields": { status: 204 },
		});
		const value = report();
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => <PatientTab sheet={sheet} report={value} />}
			/>,
		);
		const name = view.getByRole("textbox", { name: "Name" });
		expect(name).toHaveProperty("value", "Ada");
		expect(
			view.getByText(`Generated ${formatTime(value.createdAt)} · draft`),
		).toBeDefined();
		const save = view.getByRole("button", { name: "Save" });
		expect(save).toHaveProperty("disabled", true);
		view.getByText("All changes saved");

		fireEvent.change(view.getByRole("textbox", { name: "Physician" }), {
			target: { value: "Dr. Who" },
		});
		view.getByText("Changes not saved");
		expect(save).toHaveProperty("disabled", false);
		fireEvent.click(save);
		// Busy until the server replies.
		expect(save).toHaveProperty("disabled", true);
		await waitFor(() => expect(save).toHaveProperty("disabled", false));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toMatchObject({ physician: "Dr. Who" });
	});

	test("a field over the limit shows why and blocks the save", () => {
		serve({});
		const value = report();
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => <PatientTab sheet={sheet} report={value} />}
			/>,
		);
		const hospital = view.getByRole("textbox", { name: "Hospital" });
		fireEvent.change(hospital, { target: { value: "x".repeat(201) } });
		view.getByText("Hospital is 201 characters. The limit is 200.");
		expect(hospital.getAttribute("aria-invalid")).toBe("true");
		expect(view.getByRole("button", { name: "Save" })).toHaveProperty(
			"disabled",
			true,
		);
	});

	test("a reviewed report is read-only and has no Save button", () => {
		serve({});
		const value = report({ review: REVIEW });
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => <PatientTab sheet={sheet} report={value} />}
			/>,
		);
		expect(view.getByRole("textbox", { name: "Name" })).toHaveProperty(
			"readOnly",
			true,
		);
		expect(view.queryByRole("button", { name: "Save" })).toBeNull();
		view.getByText(
			`Generated ${formatTime(value.createdAt)} · reviewed, read-only`,
		);
	});
});

describe("MarkersTab", () => {
	test("labels demo values and says an unavailable marker has no source", () => {
		serve({});
		const value = report({
			markers: [
				marker("heart_rate", { synthetic: true, source: "Synthetic watch" }),
				marker("weight", {
					value: 60,
					unit: "kg",
					source: "Scale",
					quality: "unvalidated",
				}),
				marker("blood_pressure", null),
			],
		});
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => (
					<MarkersTab report={value} familyId="1" sheet={sheet} />
				)}
			/>,
		);
		view.getByText(
			"Demo data: 1 of these markers hold demo values, not real measurements.",
		);
		const rows = view
			.getAllByRole("row")
			.slice(1)
			.map((row) =>
				Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
			);
		expect(rows).toEqual([
			[
				"Heart rate",
				"72 bpmDemo value, not measured",
				"Demo watch",
				formatTime("2026-10-01T08:00:00.000Z"),
				"Validated",
			],
			[
				"Weight",
				"60 kg",
				"Scale",
				formatTime("2026-10-01T08:00:00.000Z"),
				"Not validated",
			],
			["Blood pressure", "Unavailable", "No source", "—", "—"],
		]);
	});

	test("says when the report has no markers", () => {
		serve({});
		const value = report();
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => (
					<MarkersTab report={value} familyId="1" sheet={sheet} />
				)}
			/>,
		);
		view.getByText(
			"No measures were saved for this person when the report was made.",
		);
		expect(view.queryByRole("note")).toBeNull();
		expect(view.queryByRole("table")).toBeNull();
	});

	test("shows a correction beside the original and removes it from the draft", () => {
		serve({});
		const value = report({
			markers: [marker("heart_rate")],
			fields: {
				...report().fields,
				corrections: [{ metric: "heart_rate", value: 70, reason: "Typo" }],
			},
		});
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => (
					<MarkersTab report={value} familyId="1" sheet={sheet} />
				)}
			/>,
		);
		view.getByText(
			/Corrected to 70 bpm: Typo\. The value above is the original\./,
		);
		view.getByText("All changes saved");
		fireEvent.click(view.getByRole("button", { name: "Remove" }));
		expect(view.queryByText(/Corrected to/)).toBeNull();
		view.getByText("Changes not saved");
	});

	test("a reviewed report shows a correction without a Remove button", () => {
		serve({});
		const value = report({
			review: REVIEW,
			markers: [marker("heart_rate")],
			fields: {
				...report().fields,
				corrections: [{ metric: "heart_rate", value: 70, reason: "Typo" }],
			},
		});
		const view = render(
			<Sheet
				value={value}
				tab={(sheet) => (
					<MarkersTab report={value} familyId="1" sheet={sheet} />
				)}
			/>,
		);
		view.getByText(/Corrected to 70 bpm: Typo\./);
		expect(view.queryByRole("button", { name: "Remove" })).toBeNull();
	});
});

describe("DailyTab", () => {
	test("says a section is not included when the report predates it", () => {
		serve({});
		const view = render(<DailyTab report={report()} />);
		expect(view.getAllByText("Not included in this report.")).toHaveLength(2);
	});

	test("says when an included section is empty", () => {
		serve({});
		const view = render(
			<DailyTab report={report({ meals: [], unresolved: [] })} />,
		);
		view.getByText("None saved.");
		view.getByText("None.");
	});

	test("lists each saved meal fact and unresolved reminder", () => {
		serve({});
		const view = render(
			<DailyTab
				report={report({
					meals: [
						{
							mealId: "m1",
							intake: "not_reported",
							facts: [
								{
									id: "5",
									fact: {
										type: "photo_taken",
										capturedAt: "2026-10-01T07:00:00Z",
									},
									recordedBy: "a".repeat(64),
									recordedAt: "2026-10-01T07:00:00Z",
								},
							],
						},
					],
					unresolved: [
						{
							occurrence: {
								id: "9",
								reminderId: "3",
								familyId: "1",
								kind: "medication",
								subjectId: null,
								title: "Take pills",
								scheduledFor: "2026-10-01T08:00:00Z",
								state: "delivered",
								promptDue: false,
								prompts: 1,
								nextPromptAt: null,
							},
							events: [],
						},
					],
				})}
			/>,
		);
		expect(
			view.getAllByRole("listitem").map((item) => item.textContent),
		).toEqual([
			"Photo taken at 2026-10-01T07:00:00Z. The photo is not kept.",
			"Take pills (medication reminder for 2026-10-01T08:00:00Z): unresolved.",
		]);
	});
});

describe("NotesTab", () => {
	test("counts the characters of each note and flags one over the limit", () => {
		serve({});
		const view = render(
			<Sheet value={report()} tab={(sheet) => <NotesTab sheet={sheet} />} />,
		);
		expect(view.getAllByText("0 of 4000 characters")).toHaveLength(3);
		const questions = view.getByRole("textbox", {
			name: /^Questions for a clinician/,
		});
		fireEvent.change(questions, { target: { value: "  Why?  " } });
		view.getByText("4 of 4000 characters");
		view.getByText("Changes not saved");
		fireEvent.change(questions, { target: { value: "x".repeat(4001) } });
		view.getByText(
			"Questions for a clinician is 4001 characters. The limit is 4000.",
		);
		expect(questions.getAttribute("aria-invalid")).toBe("true");
	});
});

describe("SendTab", () => {
	const renderSend = (
		value: Report,
		patch: Partial<ReportSheetState> = {},
		onAsk = () => {},
	) =>
		render(
			<Sheet
				value={value}
				patch={patch}
				tab={(sheet) => (
					<SendTab
						sheet={sheet}
						report={value}
						reports={[value]}
						familyId="1"
						onAsk={onAsk}
					/>
				)}
			/>,
		);

	test("a draft must be confirmed and reviewed before it can be sent", async () => {
		const calls = serve({
			"POST /api/families/1/reports/r1/review": { status: 204 },
		});
		const view = renderSend(report());
		view.getByText("Hospital: not sent. Mark the report as reviewed first.");
		view.getByText("Email: not emailed.");
		for (const name of ["Send to hospital…", "Send by email"])
			expect(view.getByRole("button", { name })).toHaveProperty(
				"disabled",
				true,
			);
		const mark = view.getByRole("button", { name: "Mark as reviewed" });
		expect(mark).toHaveProperty("disabled", true);
		fireEvent.click(view.getByRole("checkbox"));
		expect(mark).toHaveProperty("disabled", false);
		fireEvent.click(mark);
		expect(mark).toHaveProperty("disabled", true);
		await waitFor(() => expect(mark).toHaveProperty("disabled", false));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/api/families/1/reports/r1/review");
	});

	test("unsaved changes block the review", () => {
		serve({});
		const view = renderSend(report(), { dirty: true, confirmed: true });
		view.getByText("Save your changes before you mark the report as reviewed.");
		expect(
			view.getByRole("button", { name: "Mark as reviewed" }),
		).toHaveProperty("disabled", true);
	});

	test("a reviewed report can be sent", () => {
		serve({});
		const onAsk = mock(() => {});
		const email = mock(async () => {});
		const view = renderSend(report({ review: REVIEW }), { email }, onAsk);
		view.getByText(
			`Reviewed ${formatTime(REVIEWED_AT)}. The report is read-only.`,
		);
		view.getByText("Hospital: not sent.");
		expect(view.queryByRole("checkbox")).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Send to hospital…" }));
		expect(onAsk).toHaveBeenCalledTimes(1);
		fireEvent.click(view.getByRole("button", { name: "Send by email" }));
		expect(email).toHaveBeenCalledTimes(1);
	});

	test.each([
		[
			{ status: "queued", reason: null, automatic: false },
			"Email: sending to doc@example.test…",
		],
		[
			{ status: "sent", reason: null, automatic: true },
			`Email: sent to doc@example.test ${formatTime(REVIEWED_AT)} (automatic).`,
		],
		[
			{ status: "failed", reason: "Mailbox full", automatic: false },
			`Email: failed to doc@example.test ${formatTime(REVIEWED_AT)}: Mailbox full`,
		],
		[
			{ status: "failed", reason: null, automatic: false },
			`Email: failed to doc@example.test ${formatTime(REVIEWED_AT)}: no reason given`,
		],
	] satisfies [Omit<ReportEmail, "recipient" | "updatedAt">, string][])(
		"shows the latest email (%#)",
		(email, text) => {
			serve({});
			const view = renderSend(
				report({
					review: REVIEW,
					email: {
						...email,
						recipient: "doc@example.test",
						updatedAt: REVIEWED_AT,
					},
				}),
			);
			view.getByText(text);
		},
	);

	test("an unavailable delivery path shows the server's words", () => {
		serve({});
		const sendFailure: ApiFailure = {
			kind: "unavailable",
			message: "Hospital delivery is not set up.",
		};
		const view = renderSend(report({ review: REVIEW }), { sendFailure });
		expect(view.getByRole("alert").textContent).toBe(
			"Hospital delivery is not set up.",
		);
	});

	test("another send failure says the report was not sent", () => {
		serve({});
		const view = renderSend(report({ review: REVIEW }), {
			sendFailure: { kind: "signed_out" },
		});
		expect(view.getByRole("alert").textContent).toBe(
			"Not sent: Sign in again.",
		);
	});
});

describe("SendDialog", () => {
	test("names the hospital and sends or cancels", () => {
		serve({});
		const onSend = mock(() => {});
		const onCancel = mock(() => {});
		const view = render(
			<SendDialog hospital="St. Mary" onSend={onSend} onCancel={onCancel} />,
		);
		view.getByText(/Send this report to St\. Mary\?/);
		fireEvent.click(view.getByRole("button", { name: "Send" }));
		expect(onSend).toHaveBeenCalledTimes(1);
		fireEvent.click(view.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	test("Escape cancels, and other keys do nothing", () => {
		serve({});
		const onCancel = mock(() => {});
		const view = render(
			<SendDialog hospital={null} onSend={() => {}} onCancel={onCancel} />,
		);
		view.getByText(/Send this report to the hospital\?/);
		const dialog = view.getByRole("alertdialog");
		fireEvent.keyDown(dialog, { key: "Enter" });
		expect(onCancel).not.toHaveBeenCalled();
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
