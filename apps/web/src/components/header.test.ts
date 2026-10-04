import { describe, expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";

import { Route as care } from "@/routes/care";
import { Route as dashboard } from "@/routes/dashboard";

import { inMoreMenu } from "./header";

describe("More menu", () => {
	test("shows pressed on its own screens and on pages under them", () => {
		for (const path of ["/bedtime", "/trip", "/care-profile", "/settings/x"])
			expect(inMoreMenu(path)).toBe(true);
	});

	test("stays raised on bar screens and on look-alike paths", () => {
		for (const path of ["/hud", "/family", "/reports", "/bedtimes", "/"])
			expect(inMoreMenu(path)).toBe(false);
	});
});

describe("merged screens", () => {
	// The real `/care` and `/dashboard` redirects, mounted at their paths in a small route tree.
	const root = createRootRoute();
	const tree = root.addChildren([
		createRoute({ ...care.options, getParentRoute: () => root, path: "/care" }),
		createRoute({
			...dashboard.options,
			getParentRoute: () => root,
			path: "/dashboard",
		}),
		createRoute({ getParentRoute: () => root, path: "/care-profile" }),
		createRoute({ getParentRoute: () => root, path: "/family" }),
	]);
	const open = async (path: string) => {
		const router = createRouter({
			routeTree: tree,
			history: createMemoryHistory({ initialEntries: [path] }),
			// A browser router: Bun has no `window`, so the router would otherwise run as a server.
			isServer: false,
			origin: "http://app.test",
		});
		await router.load();
		return router.state.location.pathname;
	};

	test("an old Care link opens the care plan", async () => {
		expect(await open("/care")).toBe("/care-profile");
	});

	test("an old Dashboard link opens Family", async () => {
		expect(await open("/dashboard")).toBe("/family");
	});
});
