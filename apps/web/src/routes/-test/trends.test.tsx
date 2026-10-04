import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ME = "a".repeat(64);
const OTHER = "b1c2d3".padEnd(64, "0");
const TRENDS = "POST /api/families/fam-1/trends";

const observation = {
	kind: "measured",
	label: "resting_heart_rate",
	source: "Oura",
	synthetic: false,
	quality: "validated",
	unit: "bpm",
	from: "2026-09-28T08:00:00.000Z",
	to: "2026-10-04T08:00:00.000Z",
	first: 62,
	last: 55,
	count: 5,
	direction: "down",
	lastSyncAt: "2026-10-04T11:30:00.000Z",
	lastSyncMinutes: 30,
	stale: false,
};

const empty = {
	question: "Is her sleep changing?",
	from: "2026-09-27",
	to: "2026-10-04",
	observations: [],
	unknown: [],
	conflicts: [],
	carePlan: { status: "not_shared", routines: [], instructions: [], notes: [] },
	nextSteps: [],
	cautions: [],
	generatedAt: "2026-10-04T12:00:00.000Z",
};

const full = {
	...empty,
	observations: [
		{
			...observation,
			kind: "reported",
			label: "question",
			source: ME,
			quality: "self_reported",
			unit: null,
			from: "2026-10-04T09:00:00.000Z",
			to: "2026-10-04T09:00:00.000Z",
			first: "She seems tired",
			last: "She seems tired",
			count: 1,
			direction: "text",
			lastSyncAt: null,
			lastSyncMinutes: null,
		},
		{
			...observation,
			kind: "reported",
			label: "question",
			source: OTHER,
			quality: "self_reported",
			unit: null,
			first: "Sleeping late",
			last: "Sleeping late",
			count: 1,
			direction: "text",
		},
		observation,
		{
			...observation,
			label: "hemoglobin",
			source: "Quest lab",
			quality: "source_reported",
			unit: null,
			from: "2026-03-01",
			to: "2026-03-01",
			first: 13.1,
			last: 13.1,
			count: 1,
			direction: "single",
			lastSyncAt: "2026-10-02T12:00:00.000Z",
			stale: true,
		},
		{
			...observation,
			kind: "derived",
			label: "recovery",
			source: "Whoop",
			synthetic: true,
			quality: "unvalidated",
			unit: "%",
			first: 70,
			last: 71,
			direction: "flat",
		},
	],
	unknown: ["No weight data in this period."],
	conflicts: ["Oura and Whoop disagree about sleep."],
	carePlan: {
		status: "shared",
		routines: [
			{ name: "Walk", time: "09:00", timeZone: "Europe/Berlin" },
			{ name: "Nap", time: null, timeZone: null },
		],
		instructions: [
			{
				name: "Fluids",
				instruction: "Offer water",
				times: ["10:00", "15:00"],
				timeZone: "Europe/Berlin",
				source: "Dr. Lee",
				effectiveDate: "2026-09-01",
			},
			{
				name: "Rest",
				instruction: "Sit after meals",
				times: [],
				timeZone: null,
				source: "Care plan",
				effectiveDate: "2026-08-01",
			},
		],
		notes: ["Medication instructions are not shown."],
	},
	nextSteps: [{ kind: "check_in", text: "Ask how she slept." }],
	cautions: [
		"Chest pain can be a heart attack. Call emergency services.",
		"This is not a diagnosis.",
	],
};

const items = (region: string) =>
	within(screen.getByRole("region", { name: region }))
		.queryAllByRole("listitem")
		.map((item) => item.textContent);

async function ask(question: string, days?: string) {
	const field = await screen.findByLabelText(
		"Your question or what you noticed",
	);
	fireEvent.change(field, { target: { value: question } });
	if (days !== undefined)
		fireEvent.change(screen.getByLabelText("Period"), {
			target: { value: days },
		});
	fireEvent.click(screen.getByRole("button", { name: "Explain the trend" }));
}

test("with no paired person, says so instead of showing the form", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	renderRoute("/trends");

	expect(
		await screen.findByText(/No person is paired with this account yet/),
	).toBeTruthy();
	expect(screen.getByRole("heading", { name: "No person" })).toBeTruthy();
	expect(
		screen.queryByLabelText("Your question or what you noticed"),
	).toBeNull();
});

test("asks only once a question has text, and sends the question and period", async () => {
	signIn();
	const reply = Promise.withResolvers<unknown>();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: ME,
		},
		[TRENDS]: () => reply.promise,
	});
	renderRoute("/trends");

	expect(
		await screen.findByRole("heading", { name: "Grandma Rose" }),
	).toBeTruthy();
	const button = await screen.findByRole("button", {
		name: "Explain the trend",
	});
	expect(button.hasAttribute("disabled")).toBe(true);
	fireEvent.change(screen.getByLabelText("Your question or what you noticed"), {
		target: { value: "   " },
	});
	expect(button.hasAttribute("disabled")).toBe(true);
	expect(
		screen.getAllByRole("option").map((option) => option.textContent),
	).toContain("Last 90 days");

	await ask("Is her sleep changing?", "30");

	// While the server works, the form cannot be sent again.
	expect(await screen.findByText("Waiting for the server.")).toBeTruthy();
	expect(button.hasAttribute("disabled")).toBe(true);
	expect(calls.filter((call) => call.method === "POST")).toEqual([
		expect.objectContaining({
			path: "/api/families/fam-1/trends",
			body: { question: "Is her sleep changing?", days: 30 },
		}),
	]);

	reply.resolve(full);
	expect(
		await screen.findByRole("article", { name: "Trend explanation" }),
	).toBeTruthy();
	expect(button.hasAttribute("disabled")).toBe(false);
});

test("shows each kind of evidence apart with its source, period, quality, and sync age", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: ME,
		},
		[TRENDS]: full,
	});
	renderRoute("/trends");
	await ask("Is her sleep changing?");

	// The first caution names a heart attack, so it leads as an alert and leaves the list.
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Chest pain can be a heart attack. Call emergency services.",
	);
	expect(
		screen.getByText(
			"Records from Sep 27, 2026 to Oct 4, 2026. Labs keep their own dates.",
		),
	).toBeTruthy();

	// The caller's own report shows as "You" once /api/me loads; another member by a short id.
	await waitFor(() =>
		expect(items("What was reported")[0]).toStartWith(
			"Question“She seems tired”You · self-reported · ",
		),
	);
	const [mine, theirs] = items("What was reported");
	expect(mine).toEndWith(" · sync time unknown");
	expect(theirs).toStartWith(
		"Question“Sleeping late”Member b1c2d3 · self-reported · ",
	);
	expect(theirs).toContain(" – ");
	expect(theirs).toEndWith("synced 30 min ago");

	const [heart, lab] = items("Measured (devices and labs)");
	expect(heart).toStartWith(
		"Resting heart rate62 bpm → 55 bpm · went down · 5 valuesOura · validated · ",
	);
	expect(lab).toBe(
		"Hemoglobin13.1 · one value · 1 valueOldQuest lab · as the lab reported it · Mar 1, 2026 · synced 2 days ago",
	);
	expect(items("Derived scores")[0]).toStartWith(
		"Recovery70 % → 71 % · about the same · 5 valuesSynthetic demo dataWhoop · not validated · ",
	);
	expect(items("Nutrition estimates")).toEqual([]);
	expect(
		within(
			screen.getByRole("region", { name: "Nutrition estimates" }),
		).getByText("None in this period."),
	).toBeTruthy();

	expect(items("Conflicting data")).toEqual([
		"Oura and Whoop disagree about sleep.",
	]);
	expect(items("Unknown or missing")).toEqual([
		"No weight data in this period.",
	]);
	expect(items("Agreed in the care plan")).toEqual([
		"Routine: Walk at 09:00 (Europe/Berlin)",
		"Routine: Nap",
		"Fluids: Offer water at 10:00, 15:00 (Europe/Berlin). Source: Dr. Lee, from 2026-09-01.",
		"Rest: Sit after meals. Source: Care plan, from 2026-08-01.",
		"Medication instructions are not shown.",
	]);
	expect(items("Next steps")).toEqual(["Ask how she slept."]);
	expect(items("Keep in mind")).toEqual(["This is not a diagnosis."]);
});

test("says when a period has no evidence and keeps other cautions in the list", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		[TRENDS]: { ...empty, cautions: ["Trends are not a diagnosis."] },
	});
	renderRoute("/trends");
	await ask("Anything new?");

	expect(
		await screen.findByRole("article", { name: "Trend explanation" }),
	).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
	expect(screen.getAllByText("None in this period.")).toHaveLength(4);
	expect(items("Conflicting data")).toEqual(["None found."]);
	expect(items("Unknown or missing")).toEqual(["Nothing listed."]);
	expect(items("Agreed in the care plan")).toEqual(["Nothing agreed."]);
	expect(items("Next steps")).toEqual(["None."]);
	expect(items("Keep in mind")).toEqual(["Trends are not a diagnosis."]);
});

test("shows why the explanation failed", async () => {
	signIn();
	const replies = [
		json(503, { error: "unavailable", message: "Wearable provider is down." }),
		json(403, { error: "forbidden", message: "Not a member of this family." }),
		{ ...empty, observations: [{ kind: "guess" }] },
	];
	serve({
		"GET /api/families": { families: [FAMILY] },
		[TRENDS]: () => {
			const next = replies.shift();
			if (next === undefined) throw new TypeError("Failed to fetch");
			return next;
		},
	});
	renderRoute("/trends");

	await ask("Is her sleep changing?");
	expect((await screen.findByRole("alert")).textContent).toContain(
		"Wearable provider is down.",
	);
	expect(screen.getByText("The trend explanation unavailable")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Explain the trend" }));
	expect(await screen.findByText("Not a member of this family.")).toBeTruthy();

	// A 2xx reply that does not match the contract is an error, never an empty explanation.
	fireEvent.click(screen.getByRole("button", { name: "Explain the trend" }));
	expect(
		await screen.findByText("Could not load the trend explanation"),
	).toBeTruthy();
	expect(screen.queryByRole("article")).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Explain the trend" }));
	await waitFor(() => expect(replies).toHaveLength(0));
	expect(
		await screen.findByText("Could not load the trend explanation"),
	).toBeTruthy();
	expect(screen.getByRole("alert").textContent).not.toContain(
		"Not a member of this family.",
	);
});

test("signed out, asks the person to sign in and sends nothing", async () => {
	const calls = serve({});
	renderRoute("/trends");

	expect(
		await screen.findByText("Sign in to see health trends.", { exact: false }),
	).toBeTruthy();
	expect(screen.getByRole("heading", { name: "No person" })).toBeTruthy();
	expect(screen.queryByText(/No person is paired/)).toBeNull();
	expect(calls).toEqual([]);
});

test("when the people cannot load, says why instead of claiming none is paired", async () => {
	signIn();
	serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "Database is not reachable.",
		}),
	});
	renderRoute("/trends");

	expect((await screen.findByRole("alert")).textContent).toContain(
		"Database is not reachable.",
	);
	expect(screen.getByText("Health trends unavailable")).toBeTruthy();
	expect(screen.queryByText(/No person is paired/)).toBeNull();
});
