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

// #245: with no paired person the app sends the person to onboarding instead of the HUD.
test("with no paired person, the HUD opens onboarding", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	const { router } = renderRoute("/hud");

	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
	expect(calls.some((c) => c.path.startsWith("/api/families/"))).toBe(false);
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

test("Today shows the next reminder and only the alerts I have not seen", async () => {
	signIn();
	const me = "a".repeat(64);
	const iso = (ms: number) =>
		new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
	const occurrence = (
		id: string,
		title: string,
		at: number,
		state: string,
	) => ({
		occurrence: {
			id,
			reminderId: id,
			familyId: "7",
			kind: "meal",
			subjectId: null,
			title,
			scheduledFor: iso(at),
			state,
			promptDue: false,
			prompts: 0,
			nextPromptAt: null,
		},
		events: [],
	});
	const alert = (id: string, summary: string) => ({
		id,
		familyId: "fam-1",
		sampleId: null,
		summary,
		raisedBy: "monitor",
		createdAt: iso(Date.now() - 60_000),
	});
	const hour = 3600_000;
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: me,
			name: null,
			givenName: null,
			email: null,
			picture: null,
		},
		"GET /api/families/fam-1": {
			...RECORDS,
			alerts: [alert("1", "Heart rate high"), alert("2", "Fall detected")],
			acknowledgements: [
				{
					id: "9",
					alertId: "2",
					familyId: "fam-1",
					member: me,
					acknowledgedAt: iso(Date.now()),
				},
			],
		},
		"GET /api/families/fam-1/reminder-occurrences": {
			occurrences: [
				occurrence("3", "Dinner", Date.now() + 5 * hour, "scheduled"),
				occurrence("2", "Lunch", Date.now() + hour, "scheduled"),
				occurrence("1", "Breakfast", Date.now() - hour, "scheduled"),
			],
		},
	});
	renderRoute("/hud");

	const next = await screen.findByText(/^Next:/);
	expect(next.textContent).toStartWith("Next: Lunch at ");
	expect(await screen.findByText("Heart rate high")).toBeTruthy();
	await waitFor(() => expect(screen.queryByText("Fall detected")).toBeNull());
});
