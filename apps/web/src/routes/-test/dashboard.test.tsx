import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before react-dom and the app load.
const { within } = await import("@testing-library/react");
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

test("shows empty states for a family with no data", async () => {
	signIn();
	const calls = serve(routes());
	renderRoute("/dashboard");

	expect(
		await screen.findByRole("heading", { name: "Grandma Rose" }),
	).toBeTruthy();
	expect(await screen.findByText("No alerts recorded.")).toBeTruthy();
	expect(
		await screen.findByText("No thresholds set: nothing is monitored."),
	).toBeTruthy();
	expect(await screen.findByText("No messages yet.")).toBeTruthy();
	expect(await screen.findByText("No health source configured.")).toBeTruthy();
	const numbers = await section("Key numbers");
	expect(numbers.getByText("HRV").nextSibling?.textContent).toBe("Unavailable");
	expect(numbers.getByText("Open alerts").nextSibling?.textContent).toBe("0");
	const nav = screen.getByRole("navigation", { name: "Dashboard" });
	expect(
		within(nav).getByRole("link", { name: "Ask" }).getAttribute("href"),
	).toBe("/chat");
	expect(
		within(nav).getByRole("link", { name: "Alerts" }).getAttribute("href"),
	).toBe("#alerts");
	expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
		"GET /api/sources",
	);
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
	renderRoute("/dashboard");

	const sources = await screen.findByRole("list", { name: "Health sources" });
	expect(within(sources).getByText("WHOOP via NOOP")).toBeTruthy();
	expect(
		within(sources).getByText("Connected · readings unvalidated"),
	).toBeTruthy();

	const alerts = await section("Recent alerts");
	const rows = await alerts.findAllByRole("row");
	expect(rows.map((r) => r.textContent)).toHaveLength(4);
	const [, first, second, third] = rows;
	expect(first?.textContent).toContain("Summary a-1");
	expect(first?.textContent).toContain("Failed after 2 tries");
	expect(first?.textContent).toContain("You, ");
	expect(second?.textContent).toContain("Sent");
	expect(second?.textContent).toContain("Not yet");
	expect(third?.textContent).toContain("No delivery record");

	const numbers = await section("Key numbers");
	expect(numbers.queryByText("HRV")).toBeNull();
	expect(numbers.getByText("Open alerts").nextSibling?.textContent).toBe("2");

	const rules = await section("Alert thresholds");
	expect(
		rules.getByText("Heart rate above 100 bpm").nextSibling?.textContent,
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

	const messages = await section("Recent messages");
	const bodies = messages.getAllByText(/^Body /).map((b) => b.textContent);
	expect(bodies).toEqual([
		"Body m-6",
		"Body m-5",
		"Body m-4",
		"Body m-3",
		"Body m-2",
	]);
	expect(messages.getByText("Telly alert")).toBeTruthy();
	expect(messages.getByText("You")).toBeTruthy();
	expect(messages.getAllByText("Member bbbbbb")).toHaveLength(3);
	expect(
		messages.getByRole("link", { name: "Open chat" }).getAttribute("href"),
	).toBe("/chat");
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
	renderRoute("/dashboard");
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
	renderRoute("/dashboard");
	await screen.findByText("No messages yet.");
	const numbers = await section("Key numbers");
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
	renderRoute("/dashboard");

	const alerts = await section("Recent alerts");
	expect(await alerts.findByText("Not a member of this family")).toBeTruthy();
	const numbers = await section("Key numbers");
	expect(
		(await numbers.findByText("Open alerts")).nextSibling?.textContent,
	).toBe("Unavailable");
	expect(await numbers.findByText("Could not load sources")).toBeTruthy();
	const rules = await section("Alert thresholds");
	expect(await rules.findByText("Thresholds unavailable")).toBeTruthy();
	expect(rules.getByText("Database down")).toBeTruthy();
	const messages = await section("Recent messages");
	expect(await messages.findByText("Could not load messages")).toBeTruthy();
	expect(messages.getByText(/The server is not reachable/)).toBeTruthy();
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
	renderRoute("/dashboard");
	expect(await screen.findByText("Loading sources…")).toBeTruthy();
	expect(
		(await section("Recent alerts")).getByText("Loading alerts…"),
	).toBeTruthy();
	expect(
		(await section("Alert thresholds")).getByText("Loading thresholds…"),
	).toBeTruthy();
	expect(
		(await section("Recent messages")).getByText("Loading messages…"),
	).toBeTruthy();
});
