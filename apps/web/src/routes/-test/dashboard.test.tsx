import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);
const { apiStart } = await import("@/lib/api");
// The failure notices show at once here, not after the window a starting API gets.
apiStart.windowMs = 0;

const ME = "a".repeat(64);
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

// Every read the Family screen makes, all empty and fine; `over` replaces single routes.
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
	serve(routes());
	const { router } = renderRoute("/dashboard");

	expect(
		await screen.findByRole("region", { name: "Family · Grandma Rose" }),
	).toBeTruthy();
	expect(router.state.location.pathname).toBe("/family");
	expect(
		(await glance()).getByText("No readings stored for this person."),
	).toBeTruthy();
	expect(screen.getByText("No alerts right now")).toBeTruthy();
	const pages = screen.getByRole("navigation", { name: "Family pages" });
	expect(
		within(pages)
			.getAllByRole("link")
			.map((link) => link.textContent),
	).toEqual([
		"Overview",
		"Daily",
		"Reminders",
		"Exercise",
		"Cooking",
		"Alerts",
		"Trends",
		"Thresholds",
	]);
	expect(
		within(screen.getByRole("navigation", { name: "Screens" }))
			.getByRole("link", { name: "Chat" })
			.getAttribute("href"),
	).toBe("/chat");

	// No alert yet: the alert summary says so, and the empty Recent alerts list is hidden.
	const alerts = await alertsTab();
	expect(await alerts.findByText("No alerts right now")).toBeTruthy();
	expect(alerts.queryByText("Recent alerts")).toBeNull();
	expect(
		await (await thresholdsTab()).findByText(
			"No thresholds set: nothing is monitored.",
		),
	).toBeTruthy();
});

test("shows loaded alerts and thresholds", async () => {
	signIn();
	serve(
		routes({
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
			"GET /api/families/fam-1": records({ samples: [sample()] }),
		}),
	);
	renderRoute("/family");

	// The newest unseen alert is the one to act on; the others are on the Alerts tab.
	expect(
		await screen.findByRole("article", { name: "Alert: Summary a-2" }),
	).toBeTruthy();
	expect((await glance()).getByText("40 ms")).toBeTruthy();

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
		"Unavailable: no recent reading",
	);
	expect(rules.getByText("SpO2 below 100 bpm").nextSibling?.textContent).toBe(
		"Unavailable: no reading",
	);
	expect(rules.getByText("Temp above 100 bpm").nextSibling?.textContent).toBe(
		"State unknown",
	);
});

test("a metric with only demo samples is unavailable; a stored WHOOP reading shows its value", async () => {
	signIn();
	serve(
		routes({
			"GET /api/families/fam-1": records({
				samples: [
					sample({ id: "s-1", synthetic: true }),
					sample({
						id: "s-2",
						metric: "heart_rate",
						value: 55,
						unit: "bpm",
						source: "noop:my-whoop",
						quality: "unvalidated",
					}),
				],
			}),
		}),
	);
	renderRoute("/family");
	const numbers = await glance();
	await waitFor(() =>
		expect(numbers.getByText("HRV").nextSibling?.textContent).toBe(
			"Unavailable",
		),
	);
	expect(numbers.getAllByText("HRV")).toHaveLength(1);
	expect(numbers.getByText("55 bpm")).toBeTruthy();
	expect(numbers.queryByText(/validated/i)).toBeNull();
});

test("shows each section's failure when the server refuses or fails", async () => {
	signIn();
	serve(
		routes({
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
	expect(await numbers.findByText("Could not load readings")).toBeTruthy();
	expect(numbers.getByText(/The server is not reachable/)).toBeTruthy();

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
			"GET /api/families/fam-1/alerts": never,
			"GET /api/families/fam-1/alert-thresholds": never,
			"GET /api/families/fam-1": never,
		}),
	);
	renderRoute("/family");
	expect(await (await glance()).findByText("Loading readings…")).toBeTruthy();
	expect(
		await (await alertsTab()).findAllByText("Loading alerts…"),
	).toHaveLength(2);
	expect(
		await (await thresholdsTab()).findByText("Loading thresholds…"),
	).toBeTruthy();
});
