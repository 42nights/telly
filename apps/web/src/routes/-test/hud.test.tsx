import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load,
// or React never listens for `input` events.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

// happy-dom has `navigator.geolocation` as null. This one reports that location is denied.
Object.defineProperty(navigator, "geolocation", {
	configurable: true,
	value: {
		getCurrentPosition: (_ok: unknown, fail: (e: { code: number }) => void) =>
			fail({ code: 1 }),
	},
});

const RECORDS = {
	families: [FAMILY],
	samples: [],
	alerts: [],
	messages: [],
	acknowledgements: [],
};

test("signed out, Talk explains that signing in is needed", async () => {
	serve({});
	renderRoute("/hud");

	expect(
		await screen.findByText("Sign in to use Talk. You can still type."),
	).toBeTruthy();
	expect(screen.getByRole("link", { name: "Meal" })).toBeTruthy();
	expect(screen.getByRole("link", { name: "Cook" })).toBeTruthy();
});

test("with no paired person, alerts and messages say so", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	renderRoute("/hud");

	expect(
		await screen.findByText("No person is paired yet, so there are no alerts."),
	).toBeTruthy();
	expect(
		screen.getByText("No person is paired yet, so there are no messages."),
	).toBeTruthy();
	expect(
		screen.getByText("Talk needs a paired person. You can still type."),
	).toBeTruthy();
});

test("when records are unavailable, shows the offline banner and retries", async () => {
	signIn();
	let down = true;
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1": () =>
			down
				? json(503, { error: "unavailable", message: "Database is down" })
				: RECORDS,
	});
	renderRoute("/hud");

	const banner = await screen.findByText("I can't connect right now.");
	expect(banner).toBeTruthy();
	expect(screen.getAllByText("Database is down").length).toBeGreaterThan(0);
	const before = calls.filter((c) => c.path === "/api/families/fam-1").length;

	down = false;
	fireEvent.click(screen.getByText("Try again"));
	await waitFor(() =>
		expect(screen.queryByText("I can't connect right now.") === null).toBe(
			true,
		),
	);
	expect(
		calls.filter((c) => c.path === "/api/families/fam-1").length,
	).toBeGreaterThan(before);
});

test("an urgent answer to a meal check-in calls for help with the wearer's words", async () => {
	signIn();
	const now = new Date();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1": RECORDS,
		"GET /api/families/fam-1/reminder-occurrences": {
			occurrences: [
				{
					occurrence: {
						id: "1",
						reminderId: "9",
						familyId: "7",
						kind: "meal",
						subjectId: null,
						title: "Lunch",
						scheduledFor: new Date(now.getTime() - 60_000)
							.toISOString()
							.replace(/\.\d+Z$/, "Z"),
						state: "delivered",
						promptDue: false,
						prompts: 1,
						nextPromptAt: "2099-01-01T00:00:00Z",
					},
					events: [],
				},
			],
		},
	});
	renderRoute("/hud");

	const words = await screen.findByPlaceholderText("Or tell me in your words");
	fireEvent.change(words, { target: { value: "I am choking" } });
	fireEvent.submit(words);

	await waitFor(() =>
		expect(
			calls.find(
				(c) =>
					c.method === "POST" && c.path === "/api/families/fam-1/emergency",
			)?.body,
		).toMatchObject({ kind: "help", report: "I am choking" }),
	);
});
