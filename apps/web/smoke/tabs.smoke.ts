// Browser smoke test: a signed-out deep link leads to the sign-in screen, and a signed-in user can
// open every tab in the taskbar without a page error. The server is faked (see fake-api.ts).
import { expect, test } from "@playwright/test";

import { signIn, watch } from "./fake-api";

test("a signed-out deep link leads to the sign-in screen", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page, baseURL);
	await page.goto("/reports");
	// #206: the app redirects to sign-in and keeps the requested page to return to.
	await expect(page).toHaveURL(/\/sign-in\?redirect=%2Freports$/);
	await expect(
		page.getByRole("heading", { name: "Sign in to Telly" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	// No nav tab or family data shows before sign-in.
	await expect(page.getByRole("navigation", { name: "Screens" })).toHaveCount(
		0,
	);
	expect(problems).toEqual([]);
});

// #254: the desktop Screens tree, in menu order, for the default family view.
const tabs = [
	{ name: "Family", path: "/family", heading: "Family · Smoke Family" },
	{ name: "Chat", path: "/chat", heading: "Family chat · Smoke Family" },
	{ name: "Care", path: "/care", heading: "Care needs" },
	{ name: "Visits", path: "/appointments", heading: "Upcoming visits" },
	{ name: "Reports", path: "/reports", heading: "Lab report properties" },
	{ name: "Home", path: "/hud", heading: /^Home · / },
	{ name: "Medicine", path: "/medicine", heading: "Find medicine" },
	{ name: "Bedtime", path: "/bedtime", heading: "Bedtime" },
	{ name: "Going out", path: "/trip", heading: "Going out" },
	{ name: "Settings", path: "/settings", heading: "Settings · Phone numbers" },
] as const;

test("a signed-in user opens every tab without a page error", async ({
	page,
	baseURL,
}) => {
	await signIn(page);
	const problems = await watch(page, baseURL);
	await page.goto("/");
	const nav = page.getByRole("navigation", { name: "Screens" });
	await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
	expect(await nav.getByRole("link").allInnerTexts()).toEqual(
		tabs.map((tab) => tab.name),
	);
	for (const tab of tabs) {
		await test.step(tab.name, async () => {
			const link = nav.getByRole("link", { name: tab.name, exact: true });
			await link.click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(link).toHaveAttribute("aria-current", "page");
			// Loading ends first: some screens show another heading while they wait.
			await expect(page.getByText("Waiting for the server.")).toHaveCount(0);
			await expect(
				page.getByRole("heading", { level: 2, name: tab.heading, exact: true }),
			).toBeVisible();
			await expect(
				page.getByText("The server sent an unexpected reply"),
			).toHaveCount(0);
			expect(problems).toEqual([]);
		});
	}
});
