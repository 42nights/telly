import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import type {
	FinchnodeLab,
	FinchnodeSubjectLabs,
} from "@health/contracts/reports";
import {
	fireEvent,
	installDom,
	type Reply,
	render,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { FinchnodeLabsPanel } from "./finchnode-labs";
import { formatTime } from "./logic";

installDom();

const START = "POST /api/families/f1/finchnode/sessions";
const LINK = "POST /api/families/f1/finchnode/sessions/s%2F1/link";
const LABS = "GET /api/families/f1/finchnode/labs";
const CONNECT = "https://connect.finchnode.test/s1";

const session = (linked: boolean, url: string | null = CONNECT) => ({
	json: { sessionId: "s/1", url, linked, synthetic: false },
});

const lab: FinchnodeLab = {
	id: "l1",
	name: "Hemoglobin",
	value: 13.2,
	unit: "g/dL",
	status: "final",
	date: "2026-02-01T08:00:00Z",
	referenceRange: "12.0-15.5",
	interpretation: "Normal",
	source: "epic",
	sourceName: "Northstar Lab",
	sourceRecordId: null,
	codes: [],
	sourceUpdatedAt: null,
	syncedAt: null,
};

const subject: FinchnodeSubjectLabs = {
	subject: "sub-1",
	synthetic: false,
	access: "granted",
	syncStatus: "complete",
	dataAsOf: "2026-02-02T08:00:00Z",
	warnings: [],
	sources: [
		{ system: "epic", organization: "Northstar Health", lastSyncedAt: null },
		{ system: "cerner", organization: null, lastSyncedAt: null },
	],
	labs: [lab],
};

const labs = (...subjects: FinchnodeSubjectLabs[]) => ({ json: { subjects } });

let open: Mock<typeof window.open>;
let consoleError: Mock<typeof console.error>;
beforeEach(() => {
	open = spyOn(window, "open").mockImplementation(() => null);
	consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	open.mockRestore();
	consoleError.mockRestore();
	setSystemTime();
});

const renderPanel = () => {
	const view = render(<FinchnodeLabsPanel familyId="f1" />);
	const fetchButton = view.getByRole("button", {
		name: "Fetch health data from Finchnode",
	});
	return { view, fetchButton };
};

describe("FinchnodeLabsPanel", () => {
	test("a linked session opens FinchNode, reads the labs, and shows the fetch time", async () => {
		setSystemTime(new Date("2026-03-05T14:30:00Z"));
		const calls = serve({ [START]: session(true), [LABS]: labs(subject) });
		const { view, fetchButton } = renderPanel();
		expect(view.getByText(/Last fetch: not yet/)).toBeDefined();
		fireEvent.click(fetchButton);
		await view.findByRole("table");
		expect(open).toHaveBeenCalledWith(CONNECT, "_blank", "noopener");
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([START, LABS]);
		expect(
			view.getByText(`Last fetch: ${formatTime(Date.now())}`, { exact: false }),
		).toBeDefined();
		expect(consoleError).not.toHaveBeenCalled();
	});

	test("shows each step while it works and blocks a second fetch", async () => {
		let reply: (value: Reply) => void = () => {};
		serve({
			[START]: session(true),
			[LABS]: () => new Promise<Reply>((resolve) => (reply = resolve)),
		});
		const { view, fetchButton } = renderPanel();
		fireEvent.click(fetchButton);
		expect(view.getByRole("status").textContent).toBe(
			"Starting a FinchNode session…",
		);
		expect(fetchButton.hasAttribute("disabled")).toBe(true);
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Reading lab results…"),
		);
		reply(labs());
		expect(
			await view.findByText(
				"No patient is linked to FinchNode yet. No lab results.",
			),
		).toBeDefined();
		expect(fetchButton.hasAttribute("disabled")).toBe(false);
	});

	test("waits for the patient's approval, checks again, then reads the labs", async () => {
		let linked = false;
		const calls = serve({
			[START]: session(false),
			[LINK]: () => session(linked, null),
			[LABS]: labs(subject),
		});
		const { view, fetchButton } = renderPanel();
		fireEvent.click(fetchButton);
		const connect = await view.findByRole("link", {
			name: "(open FinchNode Connect)",
		});
		expect(connect.getAttribute("href")).toBe(CONNECT);
		expect(view.getByRole("status").textContent).toContain(
			"Approve sharing in FinchNode",
		);

		// Not approved yet: still waiting, and the Connect link stays.
		fireEvent.click(view.getByRole("button", { name: "Check sharing" }));
		await waitFor(() => expect(calls).toHaveLength(2));
		expect((await view.findByRole("link")).getAttribute("href")).toBe(CONNECT);

		linked = true;
		fireEvent.click(view.getByRole("button", { name: "Check sharing" }));
		await view.findByRole("table");
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			START,
			LINK,
			LINK,
			LABS,
		]);
	});

	test("a session without a Connect page opens nothing and offers no link", async () => {
		serve({ [START]: session(false, null) });
		const { view, fetchButton } = renderPanel();
		fireEvent.click(fetchButton);
		await view.findByRole("button", { name: "Check sharing" });
		expect(view.queryByRole("link")).toBeNull();
		expect(open).not.toHaveBeenCalled();
	});

	test.each([
		[{ status: 401 }, "Sign in to fetch health data."],
		[
			{ status: 503, body: { error: "unavailable", message: "No API key" } },
			"FinchNode is unavailable: No API key",
		],
		[
			{ status: 403, body: { error: "forbidden", message: "Not a member" } },
			"FinchNode is not reachable: Not a member",
		],
		[
			{ status: 502, body: { error: "upstream_error", message: "Timed out" } },
			"FinchNode is not reachable: Timed out",
		],
	] satisfies [Reply, string][])(
		"a failed start says why (%#)",
		async (reply, text) => {
			serve({ [START]: reply });
			const { view, fetchButton } = renderPanel();
			fireEvent.click(fetchButton);
			expect((await view.findByRole("alert")).textContent).toBe(text);
			expect(fetchButton.hasAttribute("disabled")).toBe(false);
		},
	);

	test("a failed sharing check or lab read says why", async () => {
		let labsReply: Reply = {
			status: 503,
			body: { error: "unavailable", message: "Labs down" },
		};
		serve({
			[START]: session(false),
			[LINK]: { status: 500, body: { error: "internal", message: "Boom" } },
			[LABS]: () => labsReply,
		});
		const { view, fetchButton } = renderPanel();
		fireEvent.click(fetchButton);
		fireEvent.click(await view.findByRole("button", { name: "Check sharing" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"FinchNode is not reachable: Boom",
		);

		serve({ [START]: session(true), [LABS]: () => labsReply });
		fireEvent.click(fetchButton);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe(
				"FinchNode is unavailable: Labs down",
			),
		);
		labsReply = { json: { subjects: "none" } };
		fireEvent.click(fetchButton);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toStartWith(
				"FinchNode is not reachable: The server sent an unexpected reply",
			),
		);
	});
});

describe("subject labs", () => {
	const show = async (...subjects: FinchnodeSubjectLabs[]) => {
		serve({ [START]: session(true), [LABS]: labs(...subjects) });
		const { view, fetchButton } = renderPanel();
		fireEvent.click(fetchButton);
		await waitFor(() =>
			expect(view.getAllByRole("group").length).toBe(subjects.length),
		);
		return view.getAllByRole("group");
	};

	test("shows sync state, sources, and each lab as the source sent it", async () => {
		const [group] = await show(subject, {
			...subject,
			subject: "sub-2",
			syncStatus: null,
			dataAsOf: null,
			sources: [],
			labs: [
				{
					...lab,
					id: "l2",
					value: null,
					date: null,
					interpretation: null,
					referenceRange: null,
					source: null,
					sourceName: null,
				},
			],
		});
		const page = within(document.body);
		expect(page.queryByText("FinchNode demo data")).toBeNull();
		expect(page.queryByRole("alert")).toBeNull();
		if (group === undefined) throw new Error("no subject shown");
		expect(
			within(group).getByText(
				`Sync: complete. Data as of ${formatTime(subject.dataAsOf ?? "")}. From Northstar Health, cerner.`,
			),
		).toBeDefined();
		const rows = page.getAllByRole("row").filter((row) => row.closest("tbody"));
		expect(
			rows.map((row) =>
				within(row)
					.getAllByRole("cell")
					.map((cell) => cell.textContent),
			),
		).toEqual([
			[
				"HemoglobinSource says: Normal",
				"13.2 g/dL",
				formatTime(lab.date ?? ""),
				"12.0-15.5 (range from Northstar Lab)",
				"Northstar Lab",
			],
			["Hemoglobin", "No value reported", "Not dated", "—", "Not named"],
		]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	test("says demo for synthetic records everywhere and logs it", async () => {
		const [group] = await show({
			...subject,
			synthetic: true,
			syncStatus: "synthetic_data",
			warnings: ["synthetic_source", "partial"],
			sources: [
				{
					system: "Synthetic EHR",
					organization: null,
					lastSyncedAt: null,
				},
			],
			labs: [
				{
					...lab,
					name: "Synthetic hemoglobin",
					interpretation: "SYNTHETIC",
					sourceName: "Synthetic Lab",
				},
			],
		});
		if (group === undefined) throw new Error("no subject shown");
		const inGroup = within(group);
		expect(inGroup.getByText("FinchNode demo data")).toBeDefined();
		expect(
			inGroup.getByText(/^Sync: Demo records, not real patient data\. /),
		).toBeDefined();
		expect(inGroup.getByText(/From Demo EHR\.$/)).toBeDefined();
		expect(inGroup.getByRole("alert").textContent).toBe(
			"FinchNode warnings: demo_source, partial",
		);
		expect(inGroup.getByText("Source says: DEMO")).toBeDefined();
		expect(inGroup.getByText("12.0-15.5 (range from Demo Lab)")).toBeDefined();
		expect(inGroup.getByRole("cell", { name: "Demo Lab" })).toBeDefined();
		expect(consoleError).toHaveBeenCalledWith(
			"FinchNode sent demo records for 1 subject(s). They are not real patient data.",
		);
	});

	test("explains missing access and an empty result instead of a table", async () => {
		const groups = await show(
			{ ...subject, subject: "a", access: "inactive", labs: [] },
			{ ...subject, subject: "b", access: "not_granted", labs: [] },
			{ ...subject, subject: "c", labs: [] },
		);
		expect(groups.map((group) => group.lastElementChild?.textContent)).toEqual([
			"The patient turned off sharing. No results are shown.",
			"The patient's sharing does not include lab results.",
			"The source has no lab results.",
		]);
		expect(within(document.body).queryByRole("table")).toBeNull();
	});
});
