import { describe, expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

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
	/** Where a route's `beforeLoad` sends the browser, or null when it lets the page load. */
	const target = (beforeLoad: ((context: never) => unknown) | undefined) => {
		// Both redirects ignore the router context, so the test passes none.
		const noContext = undefined as never;
		try {
			beforeLoad?.(noContext);
		} catch (thrown) {
			if (isRedirect(thrown)) return thrown.options.to;
			throw thrown;
		}
		return null;
	};

	test("an old Care link opens the care plan", () => {
		expect(target(care.options.beforeLoad)).toBe("/care-profile");
	});

	test("an old Dashboard link opens Family", () => {
		expect(target(dashboard.options.beforeLoad)).toBe("/family");
	});
});
