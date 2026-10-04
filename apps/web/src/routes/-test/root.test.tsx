import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before these modules load.
const { waitFor } = await import("@testing-library/react");
const { FAMILY, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const PATHS = [
	"/",
	"/hud",
	"/medicine",
	"/find",
	"/bedtime",
	"/trip",
	"/family",
	"/care-profile",
	"/chat",
	"/care",
	"/dashboard",
	"/reports",
	"/appointments",
	"/settings",
	"/trends",
	"/family/trends",
	"/family/alerts",
	"/family/thresholds",
	"/care/contacts",
	"/care/plan",
	"/care/sharing",
	"/settings/device",
	"/settings/demo",
	"/settings/going-out",
	"/settings/things",
	"/settings/reports",
	"/settings/speaker",
	"/welcome",
	"/meal",
	"/cooking",
];

test("signed out, every app page shows only the sign-in screen and returns there after", async () => {
	for (const path of PATHS) {
		const href = `${path}?x=1`;
		const calls = serve({});
		const { router, unmount } = renderRoute(href);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/sign-in"),
		);
		expect(router.state.location.search).toEqual({ redirect: href });
		expect(
			await screen.findByRole("heading", {
				name: "Sign in or create an account",
			}),
		).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "Screens" })).toBeNull();
		expect(calls.filter((c) => c.path.startsWith("/api"))).toEqual([]);
		unmount();
	}
});

// #254: `/` opens this device's view home, Family by default.
test("/ redirects to Family inside the app layout with its head tags", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { router } = renderRoute("/");
	await waitFor(() => expect(router.state.location.pathname).toBe("/family"));
	expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
	await waitFor(() => expect(document.title).toBe("Family · Telly"));
	expect(
		document.querySelector('meta[name="description"]')?.getAttribute("content"),
	).toBe("Telly: day-to-day help for memory loss, with the family in the loop");
});

test("each page names itself in the tab title", async () => {
	for (const [path, title] of [
		["/sign-in", "Sign in · Telly"],
		["/find", "Find · Telly"],
		["/settings/device", "Device · Telly"],
		["/family/alerts", "Alerts · Telly"],
		["/hud", "HUD · Telly"],
	] as const) {
		if (path !== "/sign-in") signIn();
		serve({ "GET /api/families": { families: [FAMILY] } });
		const { unmount } = renderRoute(path);
		await waitFor(() => expect(document.title).toBe(title));
		unmount();
	}
});
