import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { Report } from "@health/contracts/reports";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { FamilyProvider } from "@/lib/family";
import {
	fireEvent,
	installDom,
	type Routes,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { formatTime } from "./logic";
import { ReportScreen } from "./report-sheet";

installDom();

const FAMILIES = {
	json: {
		families: [{ id: "1", name: "Ada", createdAt: "2026-01-01T00:00:00Z" }],
	},
};
const REPORTS = "GET /api/families/1/reports";
const REVIEWED_AT = "2026-10-02T10:00:00.000Z";

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
		patientName: "Ada Lovelace",
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: "St. Mary",
		notes: null,
		observations: null,
		questions: null,
		corrections: [],
	},
	review: null,
	...over,
});

const screen = (routes: Routes) => {
	const calls = serve({ "GET /api/families": FAMILIES, ...routes });
	const ui = (
		<FamilyProvider>
			<ReportScreen />
		</FamilyProvider>
	);
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory(),
	});
	const view = render(<RouterProvider router={router} />);
	return { calls, view };
};

const reportReads = (calls: readonly { method: string; path: string }[]) =>
	calls.filter((call) => `${call.method} ${call.path}` === REPORTS).length;

describe("ReportScreen before a report", () => {
	test("waits for the family list", async () => {
		const { view } = screen({
			"GET /api/families": () => Promise.withResolvers<ServerReply>().promise,
		});
		await view.findByText("Waiting for the server.");
		view.getByText("No report");
	});

	test("says that no person is paired when the caller has no family", async () => {
		const { view } = screen({
			"GET /api/families": { json: { families: [] } },
		});
		await waitFor(() => view.getByText("No person is paired yet."));
	});

	test("shows why the family list failed", async () => {
		const { view } = screen({
			"GET /api/families": {
				status: 403,
				body: { error: "forbidden", message: "Not a member." },
			},
		});
		await waitFor(() => view.getByText("Not shared with you"));
	});

	test("shows why the reports failed", async () => {
		const { view } = screen({
			[REPORTS]: {
				status: 500,
				body: { error: "internal", message: "Database down." },
			},
		});
		await waitFor(() => view.getByText("Database down."));
		view.getByText("No report");
	});

	test("creates the first report and opens it", async () => {
		let reports: Report[] = [];
		const created = Promise.withResolvers<ServerReply>();
		const { calls, view } = screen({
			[REPORTS]: () => ({ json: { reports } }),
			"POST /api/families/1/reports": () => created.promise,
		});
		await waitFor(() =>
			view.getByText(
				"No reports yet. A new report collects the latest reading of each measure saved for Ada.",
			),
		);
		view.getByText("No reports yet");
		fireEvent.click(view.getByRole("button", { name: "New report" }));
		const creating = view.getByRole("button", { name: "Creating…" });
		expect(creating).toHaveProperty("disabled", true);
		reports = [report()];
		created.resolve({ json: report() });
		await waitFor(() => view.getByText("Lab report · Ada Lovelace"));
		expect(reportReads(calls)).toBe(2);
		view.getByText("Draft · not sent");
	});

	test("a 401 to a new report ends the session and shows the sign-in notice", async () => {
		const { calls, view } = screen({
			[REPORTS]: { json: { reports: [] } },
			"POST /api/families/1/reports": { status: 401 },
		});
		fireEvent.click(
			await waitFor(() => view.getByRole("button", { name: "New report" })),
		);
		await view.findByRole("link", { name: "Go to Sign in" });
		view.getByText("No report");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
});

describe("ReportScreen with reports", () => {
	test("shows why another report was not created", async () => {
		const { view } = screen({
			[REPORTS]: { json: { reports: [report()] } },
			"POST /api/families/1/reports": {
				status: 503,
				body: { error: "unavailable", message: "Database is starting." },
			},
		});
		fireEvent.click(
			await waitFor(() => view.getByRole("button", { name: "New report" })),
		);
		await waitFor(() => view.getByText("Database is starting."));
	});

	test("labels a report without a name and with demo values", async () => {
		const { view } = screen({
			[REPORTS]: {
				json: {
					reports: [
						report({
							fields: { ...report().fields, patientName: null },
							markers: [
								{
									metric: "heart_rate",
									sample: {
										id: "s1",
										familyId: "1",
										metric: "heart_rate",
										value: 72,
										unit: "bpm",
										sourceTime: "2026-10-01T08:00:00.000Z",
										receivedAt: "2026-10-01T08:00:00.000Z",
										source: "Synthetic",
										synthetic: true,
										quality: "validated",
									},
								},
							],
						}),
					],
				},
			},
		});
		const heading = await waitFor(() =>
			view.getByRole("heading", { name: /Patient not named/ }),
		);
		expect(heading.textContent).toBe("Lab report · Patient not namedDemo data");
		// One report: nothing to pick.
		expect(view.queryByRole("combobox", { name: "Report" })).toBeNull();
	});

	test("picks another report from the list", async () => {
		const older = report({
			id: "r0",
			createdAt: "2026-09-01T09:00:00.000Z",
			fields: { ...report().fields, patientName: "Old name" },
			review: { reviewedBy: "me", reviewedAt: REVIEWED_AT },
		});
		const { view } = screen({
			[REPORTS]: { json: { reports: [report(), older] } },
		});
		const picker = await waitFor(() =>
			view.getByRole("combobox", { name: "Report" }),
		);
		expect(
			within(picker)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			`${formatTime("2026-10-01T09:00:00.000Z")} · draft`,
			`${formatTime("2026-09-01T09:00:00.000Z")} · reviewed`,
		]);
		view.getByText("Lab report · Ada Lovelace");
		fireEvent.change(picker, { target: { value: "r0" } });
		view.getByText("Lab report · Old name");
		// A reviewed report opens on its Send tab.
		expect(
			view.getByRole("tab", { name: "Send" }).getAttribute("aria-selected"),
		).toBe("true");
		view.getByText(
			`Reviewed ${formatTime(REVIEWED_AT)} · read-only · not sent`,
		);
	});

	test("switches between the tabs", async () => {
		const { view } = screen({
			[REPORTS]: { json: { reports: [report()] } },
		});
		const patient = await waitFor(() =>
			view.getByRole("tab", { name: "Patient" }),
		);
		expect(patient.getAttribute("aria-selected")).toBe("true");
		const panel = view.getByRole("tabpanel");
		expect(panel.getAttribute("aria-labelledby")).toBe("report-tab-0");
		within(panel).getByRole("textbox", { name: "Name" });

		fireEvent.click(view.getByRole("tab", { name: "Markers" }));
		expect(patient.getAttribute("aria-selected")).toBe("false");
		within(panel).getByText(
			"No measures were saved for this person when the report was made.",
		);
		fireEvent.click(view.getByRole("tab", { name: "Meals & events" }));
		expect(
			within(panel).getAllByText("Not included in this report."),
		).toHaveLength(2);
		fireEvent.click(view.getByRole("tab", { name: "Notes" }));
		within(panel).getByRole("textbox", { name: /^Notes for the physician/ });
		fireEvent.click(view.getByRole("tab", { name: "Send" }));
		expect(panel.getAttribute("aria-labelledby")).toBe("report-tab-4");
		within(panel).getByText(
			"Hospital: not sent. Mark the report as reviewed first.",
		);
	});

	test("a save reloads the reports", async () => {
		let saved = report();
		const { calls, view } = screen({
			[REPORTS]: () => ({ json: { reports: [saved] } }),
			"POST /api/families/1/reports/r1/fields": (call) => {
				saved = report({
					fields: { ...report().fields, physician: "Dr. Who" },
				});
				expect(call.body).toMatchObject({ physician: "Dr. Who" });
				return { status: 204 };
			},
		});
		const physician = await waitFor(() =>
			view.getByRole("textbox", { name: "Physician" }),
		);
		fireEvent.change(physician, { target: { value: "Dr. Who" } });
		view.getByText("Draft · changes not saved");
		fireEvent.click(view.getByRole("button", { name: "Save" }));
		await waitFor(() => view.getByText(/^Draft · saved /));
		expect(reportReads(calls)).toBe(2);
		view.getByText("All changes saved");
	});

	test("a review reopens the report read-only on its Send tab", async () => {
		let current = report();
		const { view } = screen({
			[REPORTS]: () => ({ json: { reports: [current] } }),
			"POST /api/families/1/reports/r1/review": () => {
				current = report({
					review: { reviewedBy: "me", reviewedAt: REVIEWED_AT },
				});
				return { status: 204 };
			},
		});
		fireEvent.click(
			await waitFor(() => view.getByRole("tab", { name: "Send" })),
		);
		fireEvent.click(view.getByRole("checkbox"));
		fireEvent.click(view.getByRole("button", { name: "Mark as reviewed" }));
		await waitFor(() =>
			view.getByText(
				`Reviewed ${formatTime(REVIEWED_AT)}. The report is read-only.`,
			),
		);
		expect(
			view.getByRole("tab", { name: "Send" }).getAttribute("aria-selected"),
		).toBe("true");
	});

	test("asks before sending, and a cancel sends nothing", async () => {
		const { calls, view } = screen({
			[REPORTS]: {
				json: {
					reports: [
						report({ review: { reviewedBy: "me", reviewedAt: REVIEWED_AT } }),
					],
				},
			},
			"POST /api/families/1/reports/r1/submit": { status: 204 },
		});
		const send = await waitFor(() =>
			view.getByRole("button", { name: "Send to hospital…" }),
		);
		fireEvent.click(send);
		const dialog = view.getByRole("alertdialog", { name: "Send report" });
		within(dialog).getByText(/Send this report to St\. Mary\?/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(view.queryByRole("alertdialog")).toBeNull();

		fireEvent.click(send);
		fireEvent.click(view.getByRole("button", { name: "Send" }));
		expect(view.queryByRole("alertdialog")).toBeNull();
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe(
				"Not sent: The server replied, but gave no delivery receipt.",
			),
		);
		expect(
			calls.filter((call) => call.method === "POST").map((call) => call.path),
		).toEqual(["/api/families/1/reports/r1/submit"]);
	});
});
