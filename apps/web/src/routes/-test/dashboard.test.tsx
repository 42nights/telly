import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const T = "2026-10-03T08:00:00.000Z";

const sample = (over: object = {}) => ({
	id: "s-1",
	familyId: "fam-1",
	metric: "hrv",
	value: 40,
	unit: "ms",
	sourceTime: T,
	receivedAt: T,
	source: "noop",
	synthetic: false,
	quality: "validated",
	...over,
});

const message = (id: string, sentAt: string, over: object = {}) => ({
	id,
	familyId: "fam-1",
	sender: OTHER,
	body: `Body ${id}`,
	sentAt,
	clientId: `c-${id}`,
	...over,
});

const alert = (id: string, delivery: object | null, acks: object[] = []) => ({
	alert: {
		id,
		familyId: "fam-1",
		sampleId: null,
		summary: `Summary ${id}`,
		raisedBy: "server",
		createdAt: T,
	},
	sample: null,
	delivery:
		delivery === null
			? null
			: {
					alertId: id,
					attempts: 2,
					lastError: null,
					updatedAt: T,
					...delivery,
				},
	acknowledgements: acks,
});

const threshold = (id: string, metric: string, direction: string) => ({
	id,
	familyId: "fam-1",
	metric,
	direction,
	limit: 100,
	unit: "bpm",
	maxAgeSeconds: 600,
	updatedBy: ME,
	updatedAt: T,
});

const records = (over: object = {}) => ({
	families: [FAMILY],
	samples: [],
	alerts: [],
	messages: [],
	acknowledgements: [],
	...over,
});

// Every read the dashboard makes, all empty and fine; `over` replaces single routes.
const routes = (over: Record<string, unknown> = {}) => ({
	"GET /api/families": { families: [FAMILY] },
	"GET /api/me": {
		issuer: "https://issuer.test",
		subject: "user-1",
		identity: ME,
		name: null,
		givenName: null,
		email: null,
		picture: null,
	},
	"GET /api/families/fam-1/alerts": { alerts: [] },
	"GET /api/families/fam-1/monitoring": { checkedAt: T, thresholds: [] },
	"GET /api/families/fam-1/alert-thresholds": { thresholds: [] },
	"GET /api/families/fam-1": records(),
	"GET /api/sources": { sources: [] },
	...over,
});

const section = async (name: string) =>
	within(await screen.findByRole("region", { name }));

// The old dashboard is the Family screen (#254): Overview, then the Alerts and Thresholds tabs.
const glance = () => section("Today at a glance");
const tab = (name: string) =>
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Family pages" })).getByRole(
			"link",
			{ name },
		),
	);
const alertsTab = async () => {
	tab("Alerts");
	return section("Alerts · Grandma Rose");
};
const thresholdsTab = async () => {
	tab("Thresholds");
	return section("Alert thresholds · Grandma Rose");
};

test("shows empty states for a family with no data", async () => {
	signIn();
	const calls = serve(routes());
	const { router } = renderRoute("/dashboard");

	expect(
		await screen.findByRole("heading", { name: "Grandma Rose" }),
	).toBeTruthy();
	expect(router.state.location.pathname).toBe("/family");
	expect(await screen.findByText("No messages yet.")).toBeTruthy();
	expect(await screen.findByText("No health source configured.")).toBeTruthy();
	const numbers = await glance();
	expect(numbers.getByText("HRV").nextSibling?.textContent).toBe("Unavailable");
	expect(numbers.getByText("Open alerts").nextSibling?.textContent).toBe("0");
	const pages = screen.getByRole("navigation", { name: "Family pages" });
	expect(
		within(pages).getByRole("link", { name: "Alerts" }).getAttribute("href"),
	).toBe("/family/alerts");
	expect(
		within(screen.getByRole("navigation", { name: "Screens" }))
			.getByRole("link", { name: "Chat" })
			.getAttribute("href"),
	).toBe("/chat");
	expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
		"GET /api/sources",
	);

	expect(
		await (await alertsTab()).findByText("No alerts recorded."),
	).toBeTruthy();
	expect(
		await (await thresholdsTab()).findByText(
			"No thresholds set: nothing is monitored.",
		),
	).toBeTruthy();
});

test("shows loaded alerts, thresholds, messages, and sources", async () => {
	signIn();
	serve(
		routes({
			"GET /api/sources": {
				sources: [{ source: "noop", status: "connected", lastSeenAt: T }],
			},
			"GET /api/families/fam-1/alerts": {
				alerts: [
					alert("a-1", { status: "failed" }, [
						{
							id: "k-1",
							alertId: "a-1",
							familyId: "fam-1",
							member: ME,
							acknowledgedAt: T,
						},
					]),
					alert("a-2", { status: "sent" }),
					alert("a-3", null),
				],
			},
			"GET /api/families/fam-1/alert-thresholds": {
				thresholds: [
					threshold("t-1", "heart_rate", "above"),
					threshold("t-2", "heart_rate", "below"),
					threshold("t-3", "steps", "above"),
					threshold("t-4", "spo2", "below"),
					threshold("t-5", "temp", "above"),
				],
			},
			"GET /api/families/fam-1/monitoring": {
				checkedAt: T,
				thresholds: [
					{
						threshold: threshold("t-1", "heart_rate", "above"),
						state: "in_range",
						reason: null,
						sample: null,
					},
					{
						threshold: threshold("t-2", "heart_rate", "below"),
						state: "out_of_range",
						reason: null,
						sample: null,
					},
					{
						threshold: threshold("t-3", "steps", "above"),
						state: "unavailable",
						reason: "stale",
						sample: null,
					},
					{
						threshold: threshold("t-4", "spo2", "below"),
						state: "unavailable",
						reason: "missing",
						sample: null,
					},
				],
			},
			"GET /api/families/fam-1": records({
				samples: [sample()],
				messages: [
					message("m-1", "2026-10-03T01:00:00.000Z"),
					message("m-2", "2026-10-03T02:00:00.000Z", { sender: ME }),
					message("m-3", "2026-10-03T03:00:00.000Z", { clientId: "alert-a-1" }),
					message("m-4", "2026-10-03T04:00:00.000Z"),
					message("m-5", "2026-10-03T05:00:00.000Z"),
					message("m-6", "2026-10-03T06:00:00.000Z"),
					message("m-x", "2026-10-03T07:00:00.000Z", { familyId: "fam-2" }),
				],
			}),
		}),
	);
	renderRoute("/family");

	const sources = await screen.findByRole("list", { name: "Health sources" });
	expect(within(sources).getByText("WHOOP via NOOP")).toBeTruthy();
	expect(
		within(sources).getByText("Connected · readings unvalidated"),
	).toBeTruthy();

	const numbers = await glance();
	await waitFor(() =>
		expect(numbers.getByText("Open alerts").nextSibling?.textContent).toBe("2"),
	);
	expect(numbers.queryByText("No real reading stored")).toBeNull();

	const messages = await section("Recent messages");
	const bodies = (await messages.findAllByText(/^Body /)).map(
		(b) => b.textContent,
	);
	expect(bodies).toEqual([
		"Body m-6",
		"Body m-5",
		"Body m-4",
		"Body m-3",
		"Body m-2",
	]);
	expect(messages.getByText("Telly alert")).toBeTruthy();
	expect(await messages.findByText("You")).toBeTruthy();
	expect(messages.getAllByText("Member bbbbbb")).toHaveLength(3);
	expect(
		messages.getByRole("link", { name: "Open chat" }).getAttribute("href"),
	).toBe("/chat");

	const alerts = within(await (await alertsTab()).findByRole("table"));
	const rows = alerts.getAllByRole("row");
	expect(rows).toHaveLength(4);
	const [, first, second, third] = rows;
	expect(first?.textContent).toContain("Summary a-1");
	expect(first?.textContent).toContain("Failed after 2 tries");
	expect(first?.textContent).toContain("You, ");
	expect(second?.textContent).toContain("Sent");
	expect(second?.textContent).toContain("Not yet");
	expect(third?.textContent).toContain("No delivery record");

	const rules = await thresholdsTab();
	expect(
		(await rules.findByText("Heart rate above 100 bpm")).nextSibling
			?.textContent,
	).toBe("In range");
	expect(
		rules.getByText("Heart rate below 100 bpm").nextSibling?.textContent,
	).toBe("Out of range");
	expect(rules.getByText("Steps above 100 bpm").nextSibling?.textContent).toBe(
		"Unavailable: stale reading",
	);
	expect(rules.getByText("Spo2 below 100 bpm").nextSibling?.textContent).toBe(
		"Unavailable: no validated reading",
	);
	expect(rules.getByText("Temp above 100 bpm").nextSibling?.textContent).toBe(
		"State unknown",
	);
});

test("shows a source that is not connected", async () => {
	signIn();
	serve(
		routes({
			"GET /api/sources": {
				sources: [
					{ source: "noop", status: "not_connected", lastSeenAt: null },
				],
			},
		}),
	);
	renderRoute("/family");
	expect(await screen.findByText("Unavailable: not connected")).toBeTruthy();
});

test("keeps HRV unavailable when only demo or other readings exist", async () => {
	signIn();
	serve(
		routes({
			"GET /api/families/fam-1": records({
				samples: [
					sample({ id: "s-1", synthetic: true }),
					sample({ id: "s-2", metric: "heart_rate" }),
				],
			}),
		}),
	);
	renderRoute("/family");
	await screen.findByText("No messages yet.");
	const numbers = await glance();
	expect(numbers.getByText("HRV").nextSibling?.textContent).toBe("Unavailable");
});

test("shows each section's failure when the server refuses or fails", async () => {
	signIn();
	serve(
		routes({
			"GET /api/sources": () => {
				throw new TypeError("Failed to fetch");
			},
			"GET /api/families/fam-1/alerts": json(403, {
				error: "forbidden",
				message: "Not yours",
			}),
			"GET /api/families/fam-1/alert-thresholds": json(503, {
				error: "unavailable",
				message: "Database down",
			}),
			"GET /api/families/fam-1": () => {
				throw new TypeError("Failed to fetch");
			},
		}),
	);
	renderRoute("/family");

	const numbers = await glance();
	expect(
		(await numbers.findByText("Open alerts")).nextSibling?.textContent,
	).toBe("Unavailable");
	expect(await numbers.findByText("Could not load sources")).toBeTruthy();
	const messages = await section("Recent messages");
	expect(await messages.findByText("Could not load messages")).toBeTruthy();
	expect(messages.getByText(/The server is not reachable/)).toBeTruthy();

	// The alert card and the list both say why.
	const alerts = await alertsTab();
	expect(await alerts.findAllByText("Not shared with you")).toHaveLength(2);
	const rules = await thresholdsTab();
	expect(await rules.findByText("Thresholds unavailable")).toBeTruthy();
	expect(rules.getByText("Database down")).toBeTruthy();
});

test("shows the loading notices before replies arrive", async () => {
	signIn();
	const never = () => new Promise<Response>(() => {});
	serve(
		routes({
			"GET /api/sources": never,
			"GET /api/families/fam-1/alerts": never,
			"GET /api/families/fam-1/alert-thresholds": never,
			"GET /api/families/fam-1": never,
		}),
	);
	renderRoute("/family");
	expect(await screen.findByText("Loading sources…")).toBeTruthy();
	expect(
		(await section("Recent messages")).getByText("Loading messages…"),
	).toBeTruthy();
	expect(
		await (await alertsTab()).findAllByText("Loading alerts…"),
	).toHaveLength(2);
	expect(
		await (await thresholdsTab()).findByText("Loading thresholds…"),
	).toBeTruthy();
});
