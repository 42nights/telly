import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import type { Report } from "@health/contracts/reports";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { formatTime } from "./logic";
import { PdfActions } from "./pdfs";

installDom();

const report: Report = {
	id: "r1",
	familyId: "f1",
	createdBy: "u1",
	createdAt: "2026-03-01T09:00:00Z",
	email: null,
	markers: [],
	meals: null,
	unresolved: null,
	fields: {
		patientName: null,
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
};

const pdf = {
	id: "p 1",
	reportId: "r1",
	createdAt: "2026-03-02T10:00:00Z",
	bytes: 2049,
};

const SAVE = "POST /api/families/f1/reports/r%201/pdfs";
const LIST = "GET /api/families/f1/report-pdfs";
const LINK = "GET /api/families/f1/report-pdfs/p%201";

const renderActions = () =>
	render(<PdfActions familyId="f1" reportId="r 1" reports={[report]} />);

describe("Save as PDF", () => {
	test("says saving sends nothing, shows progress, then the saved time", async () => {
		let reply: (value: ServerReply) => void = () => {};
		const calls = serve({
			[SAVE]: () => new Promise<ServerReply>((resolve) => (reply = resolve)),
		});
		const view = renderActions();
		expect(view.getByRole("status").textContent).toBe(
			"Saving a PDF does not send it to anyone.",
		);
		fireEvent.click(view.getByRole("button", { name: "Save as PDF" }));
		const busy = await view.findByRole("button", { name: "Saving PDF…" });
		expect(busy.hasAttribute("disabled")).toBe(true);
		reply({ json: pdf });
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe(
				`PDF saved ${formatTime(pdf.createdAt)}. Only you can open it.`,
			),
		);
		expect(
			view
				.getByRole("button", { name: "Save as PDF" })
				.hasAttribute("disabled"),
		).toBe(false);
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([SAVE]);
	});

	test.each([
		[
			{
				status: 503,
				body: { error: "unavailable", message: "Storage is down" },
			},
			"PDF not saved: Storage is down",
		],
		[{ status: 401 }, "PDF not saved: Sign in again."],
		[
			{ json: { id: "p1" } },
			"PDF not saved: The server sent an unexpected reply",
		],
	] satisfies [ServerReply, string][])(
		"a failed save says why (%#)",
		async (reply, text) => {
			serve({ [SAVE]: reply });
			const view = renderActions();
			fireEvent.click(view.getByRole("button", { name: "Save as PDF" }));
			await waitFor(() =>
				expect(view.getByRole("status").textContent).toStartWith(text),
			);
		},
	);
});

describe("Preview PDF", () => {
	const PREVIEW = "GET /api/families/f1/reports/r%201/pdf";

	test("shows the emailed PDF with open and download links, and frees it on close", async () => {
		// happy-dom cannot load blob: URLs into a frame.
		const url = "about:blank#pdf";
		const made = spyOn(URL, "createObjectURL").mockReturnValue(url);
		const freed = spyOn(URL, "revokeObjectURL").mockReturnValue();
		const calls = serve({ [PREVIEW]: { status: 200 } });
		const view = renderActions();
		fireEvent.click(view.getByRole("button", { name: "Preview PDF" }));
		const dialog = view.getByRole("dialog", { name: "Preview PDF" });
		const frame = await within(dialog).findByTitle("Lab report PDF");
		expect(frame.getAttribute("src")).toBe(url);
		const open = within(dialog).getByRole("link", { name: "Open in new tab" });
		expect(open.getAttribute("href")).toBe(url);
		expect(open.getAttribute("target")).toBe("_blank");
		const download = within(dialog).getByRole("link", { name: "Download" });
		expect(download.getAttribute("download")).toBe("lab-report-r 1.pdf");
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([PREVIEW]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		expect(view.queryByRole("dialog")).toBeNull();
		expect(freed).toHaveBeenCalledWith(url);
		made.mockRestore();
		freed.mockRestore();
	});

	test("a refused preview says why and offers no PDF", async () => {
		serve({
			[PREVIEW]: {
				status: 403,
				body: { error: "forbidden", message: "No health records access" },
			},
		});
		const view = renderActions();
		fireEvent.click(view.getByRole("button", { name: "Preview PDF" }));
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toStartWith("Not previewed:");
		expect(view.queryByRole("link")).toBeNull();
	});
});

describe("Past PDFs", () => {
	let assign: Mock<Location["assign"]>;
	beforeEach(() => {
		assign = spyOn(window.location, "assign").mockImplementation(() => {});
	});
	afterEach(() => assign.mockRestore());

	const open = () => {
		const view = renderActions();
		fireEvent.click(view.getByRole("button", { name: "Past PDFs…" }));
		return view;
	};

	test("waits for the list, then shows each PDF with its report and size", async () => {
		let reply: (value: ServerReply) => void = () => {};
		const calls = serve({
			[LIST]: () => new Promise<ServerReply>((resolve) => (reply = resolve)),
		});
		const view = open();
		const dialog = view.getByRole("dialog", { name: "Past PDFs" });
		expect(within(dialog).getByText("Waiting for the server.")).toBeDefined();
		await waitFor(() => expect(calls).toHaveLength(1));
		reply({
			json: {
				pdfs: [pdf, { ...pdf, id: "p2", reportId: "gone", bytes: 1024 }],
			},
		});
		await within(dialog).findAllByRole("button", { name: "Download" });
		const rows = within(dialog)
			.getAllByRole("row")
			.slice(1)
			.map((row) =>
				within(row)
					.getAllByRole("cell")
					.slice(0, 3)
					.map((cell) => cell.textContent),
			);
		expect(rows).toEqual([
			[formatTime(pdf.createdAt), formatTime(report.createdAt), "3 KB"],
			[formatTime(pdf.createdAt), "—", "1 KB"],
		]);
	});

	test("says when there are no PDFs, and shows a failed read", async () => {
		serve({ [LIST]: { json: { pdfs: [] } } });
		const view = open();
		expect(
			await view.findByText(
				"You have not saved a PDF of a report in this family.",
			),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Close" }));

		serve({
			[LIST]: {
				status: 500,
				body: { error: "internal", message: "Database error" },
			},
		});
		fireEvent.click(view.getByRole("button", { name: "Past PDFs…" }));
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("Database error");
	});

	test("downloads through a short-lived link; a refused link says why", async () => {
		let link: ServerReply = {
			status: 403,
			body: { error: "forbidden", message: "Not your PDF" },
		};
		const calls = serve({
			[LIST]: { json: { pdfs: [pdf] } },
			[LINK]: () => link,
		});
		const view = open();
		const download = await view.findByRole("button", { name: "Download" });
		fireEvent.click(download);
		expect((await view.findByRole("alert")).textContent).toBe(
			"Not downloaded: Not your PDF",
		);
		expect(assign).not.toHaveBeenCalled();

		link = {
			json: { url: "https://files.test/p1", expiresAt: "2026-03-02T10:05:00Z" },
		};
		fireEvent.click(download);
		await waitFor(() =>
			expect(assign).toHaveBeenCalledWith("https://files.test/p1"),
		);
		expect(view.queryByRole("alert")).toBeNull();
		expect(calls.filter((c) => c.path.endsWith("p%201"))).toHaveLength(2);
	});

	test("closes with Close or Escape", () => {
		serve({ [LIST]: { json: { pdfs: [] } } });
		const view = open();
		const dialog = view.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Enter" });
		expect(view.queryByRole("dialog")).not.toBeNull();
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(view.queryByRole("dialog")).toBeNull();

		fireEvent.click(view.getByRole("button", { name: "Past PDFs…" }));
		fireEvent.click(view.getByRole("button", { name: "Close" }));
		expect(view.queryByRole("dialog")).toBeNull();
	});
});
