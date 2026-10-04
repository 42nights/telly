import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { act, waitFor } = await import("@testing-library/react");
const { FAMILY, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const T = "2026-10-01T08:00:00.000Z";

// Every read of the screens below, all empty and fine.
const routes = {
	"GET /api/families": { families: [FAMILY] },
	"GET /api/me": {
		issuer: "https://issuer.test",
		subject: "user-1",
		identity: "a".repeat(64),
		name: null,
		givenName: null,
		email: null,
		picture: null,
	},
	"GET /api/families/fam-1": {
		families: [FAMILY],
		samples: [],
		alerts: [],
		messages: [],
		acknowledgements: [],
	},
	"GET /api/families/fam-1/alerts": { alerts: [] },
	"GET /api/families/fam-1/monitoring": { checkedAt: T, thresholds: [] },
	"GET /api/families/fam-1/alert-thresholds": { thresholds: [] },
	"GET /api/families/fam-1/reports": { reports: [] },
	"GET /api/families/fam-1/messages": { messages: [] },
};

// Family › Alerts, Family › Thresholds, Reports, Chat: each screen shows this once it has its data.
const SCREENS = [
	["/family/alerts", "Alerts · Grandma Rose"],
	["/family/thresholds", "Alert thresholds · Grandma Rose"],
	["/reports", "Reports"],
	["/chat", "No family messages yet."],
] as const;

test("switching between screens and back reads nothing again while the data is current", async () => {
	signIn();
	const calls = serve(routes);
	const { router } = renderRoute("/family");
	const open = async (to: string, shows: string) => {
		await act(() => router.navigate({ to }));
		expect(await screen.findAllByText(shows)).not.toHaveLength(0);
	};
	for (const [to, shows] of SCREENS) await open(to, shows);
	const firstLap = calls.length;
	expect(firstLap).toBeGreaterThan(0);
	for (const [to, shows] of SCREENS) await open(to, shows);
	await Bun.sleep(50);
	expect(calls.slice(firstLap).map((call) => call.path)).toEqual([]);
});

test("a screen opens with its cached data at once, without its loading state", async () => {
	signIn();
	serve(routes);
	const { router } = renderRoute("/reports");
	expect(await screen.findAllByText("Reports")).not.toHaveLength(0);
	await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
	await act(() => router.navigate({ to: "/chat" }));
	await act(() => router.navigate({ to: "/reports" }));
	expect(screen.queryByText(/Loading/)).toBeNull();
});

test("a switch back to a person reads their data again, never showing an earlier visit's", async () => {
	signIn();
	const OTHER = { ...FAMILY, id: "fam-2", name: "Grandpa Joe" };
	let reads = 0;
	const calls = serve({
		...routes,
		"GET /api/families": { families: [FAMILY, OTHER] },
		// The first read has an alert; the read after the switch back has not answered yet.
		"GET /api/families/fam-1/alerts": () => {
			reads += 1;
			return reads === 1
				? {
						alerts: [
							{
								alert: {
									id: "a-1",
									familyId: "fam-1",
									sampleId: null,
									summary: "Heart rate high",
									raisedBy: "server",
									createdAt: T,
								},
								sample: null,
								delivery: null,
								acknowledgements: [],
							},
						],
					}
				: Promise.withResolvers().promise;
		},
		"GET /api/families/fam-2": { ...routes["GET /api/families/fam-1"] },
		"GET /api/families/fam-2/alerts": { alerts: [] },
		"GET /api/families/fam-2/monitoring": { checkedAt: T, thresholds: [] },
		"GET /api/families/fam-2/alert-thresholds": { thresholds: [] },
	});
	const { router } = renderRoute("/family/alerts?person=fam-1");
	expect(await screen.findAllByText("Heart rate high")).not.toHaveLength(0);
	await act(() => router.navigate({ href: "/family/alerts?person=fam-2" }));
	expect(await screen.findAllByText("Alerts · Grandpa Joe")).not.toHaveLength(
		0,
	);
	await act(() => router.navigate({ href: "/family/alerts?person=fam-1" }));
	expect(await screen.findAllByText("Alerts · Grandma Rose")).not.toHaveLength(
		0,
	);
	await Bun.sleep(50);
	expect(screen.queryByText("Heart rate high")).toBeNull();
	expect(
		calls.filter((call) => call.path === "/api/families/fam-1/alerts"),
	).toHaveLength(2);
});
