// Browser smoke test: a signed-out deep link leads to the sign-in screen, and a signed-in user can
// open every tab in the taskbar without a page error. Fake: the session (an unsigned JWT-shaped ID
// token with a future `exp`, stored where the sign-in screen stores it) and the whole server API
// (`page.route` on VITE_SERVER_URL). Every other non-app request is blocked and fails the test.
import type { FamilyRecords } from "@health/contracts";
import type { FamilyList, FamilyMembers, Me } from "@health/contracts/families";
import type { LinkedFinder } from "@health/contracts/finder-link";
import type { ReminderHistory } from "@health/contracts/reminders";
import { expect, type Page, test } from "@playwright/test";

import { SERVER_URL } from "../playwright.config";

const family = {
	id: "1",
	name: "Smoke Family",
	createdAt: "2026-01-01T00:00:00.000Z",
};

// Empty-but-valid replies, in the shape of each contract the tabs decode.
const replies: Record<string, unknown> = {
	"/health": { status: "ok", service: "server" },
	"/api/sources": { sources: [] },
	"/api/me": {
		issuer: "http://127.0.0.1:9/issuer",
		subject: "smoke-user",
		identity: "a".repeat(64),
		name: null,
		givenName: null,
		email: null,
		picture: null,
	} satisfies Me,
	"/api/families": { families: [family] } satisfies FamilyList,
	"/api/families/1": {
		families: [family],
		samples: [],
		alerts: [
			{
				id: "1",
				familyId: "1",
				sampleId: null,
				summary: "Heart rate above 120 bpm",
				raisedBy: "monitor",
				createdAt: "2026-01-01T08:00:00.000Z",
			},
		],
		messages: [],
		acknowledgements: [],
	} satisfies FamilyRecords,
	"/api/families/1/members": {
		members: [{ identity: "a".repeat(64), name: null }],
	} satisfies FamilyMembers,
	"/api/families/1/alerts": { alerts: [] },
	"/api/families/1/alert-thresholds": { thresholds: [] },
	"/api/families/1/monitoring": {
		checkedAt: "2026-01-01T00:00:00.000Z",
		thresholds: [],
	},
	"/api/families/1/messages": { messages: [] },
	"/api/families/1/location": { locations: [], shares: [], seesShared: false },
	"/api/families/1/trips/current": { trip: null },
	"/api/families/1/exercise": { plans: [], sessions: [] },
	"/api/families/1/cooking/profile": {
		profile: null,
		editedBy: null,
		editedAt: null,
	},
	"/api/families/1/reminders": { reminders: [] },
	"/api/families/1/reminder-occurrences": {
		occurrences: [
			{
				occurrence: {
					id: "1",
					reminderId: "1",
					familyId: "1",
					kind: "meal",
					subjectId: null,
					title: "Lunch",
					scheduledFor: new Date(Date.now() + 3600_000)
						.toISOString()
						.replace(/\.\d+Z$/, "Z"),
					state: "scheduled",
					promptDue: false,
					prompts: 0,
					nextPromptAt: null,
				},
				events: [],
			},
		],
	} satisfies ReminderHistory,
	"/api/families/1/reminder-settings": { settings: null },
	"/api/families/1/speaker-settings": {
		settings: { enabled: false, room: "shared", sharedRoomKinds: [] },
		updatedBy: null,
		updatedAt: null,
	},
	"/api/families/1/speaker": {
		provider: "simulated",
		mode: "online",
		announcements: [],
	},
	"/api/families/1/medicine-memory": {
		personId: "a".repeat(64),
		people: ["a".repeat(64)],
		places: [],
		sightings: [],
	},
	"/api/families/1/care/needs": { needs: [] },
	"/api/families/1/care/ladder": { ladder: null },
	"/api/families/1/care-access": { mine: [], grants: [], history: [] },
	"/api/families/1/care-instructions": { instructions: [] },
	"/api/families/1/care-profile/prompt": { lines: [] },
	"/api/families/1/care-profile": {
		familyId: "1",
		profile: {
			preferredName: null,
			language: null,
			timeZone: null,
			accessibilityNeeds: null,
			diagnoses: null,
			allergies: null,
			dietaryRestrictions: null,
			fluidRestrictions: null,
			activityRestrictions: null,
			routines: null,
			contacts: null,
			familiarDestinations: null,
			devices: null,
			declinedPrompts: [],
		},
		editedBy: null,
		editedAt: null,
		history: [],
	},
	"/api/families/1/reports": { reports: [] },
	"/api/families/1/appointments": { appointments: [] },
};

// The POST replies the faked pages send: a finder link (#308) opens without sign-in.
const posts: Record<string, unknown> = {
	"/api/finder-link/open": {
		session: "s".repeat(43),
		expiresAt: new Date(Date.now() + 15 * 60_000)
			.toISOString()
			.replace(/\.\d+Z$/, "Z"),
		sightings: [
			{
				id: "1",
				container: "Lisinopril bottle",
				category: "medicine",
				place: "Kitchen counter, next to the kettle",
				seenAt: "2026-01-01T08:00:00Z",
				notFoundAt: null,
			},
			{
				id: "2",
				container: "House keys",
				category: "keys",
				place: "Hall table",
				seenAt: "2026-01-01T07:00:00Z",
				notFoundAt: "2026-01-01T09:00:00Z",
			},
		],
	} satisfies LinkedFinder,
};

/** Serves the app, fakes the API, and collects page errors and blocked requests. */
const watch = async (page: Page, baseURL: string | undefined) => {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(`page error: ${error}`));
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin === SERVER_URL) {
			const method = route.request().method();
			const body = (method === "POST" ? posts : replies)[url.pathname];
			if ((method === "GET" || method === "POST") && body !== undefined)
				return route.fulfill({ json: body });
			problems.push(`unfaked API call: ${route.request().method()} ${url}`);
			return route.fulfill({
				status: 404,
				json: { error: "not_found", message: "Not faked by the smoke test" },
			});
		}
		if (url.origin === baseURL) return route.continue();
		problems.push(`blocked request: ${url}`);
		return route.abort();
	});
	return problems;
};

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
	{ name: "Find things", path: "/find", heading: "Find things" },
	{ name: "Going out", path: "/trip", heading: "Going out" },
	{ name: "Settings", path: "/settings", heading: "Settings · Phone numbers" },
] as const;

// `eyJhbGciOiJSUzI1NiJ9` is `{"alg":"RS256"}`; the app reads only the payload's `exp`.
const signIn = (page: Page) =>
	page.addInitScript(() => {
		sessionStorage.setItem(
			"telly.session.token",
			`eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ sub: "smoke-user", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`,
		);
	});

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

// #308: the wearer reads Home and the finder link without scrolling the page, on a desktop and a phone.
const viewports = [
	{ width: 1280, height: 800 },
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;
const wearerPages = [
	{ name: "home", path: "/hud", heading: /^Home · /, signedIn: true },
	{
		name: "finder",
		path: `/find?person=1&object=2&token=${"t".repeat(43)}`,
		heading: "Find your things",
		signedIn: false,
	},
] as const;

for (const viewport of viewports)
	for (const wearerPage of wearerPages)
		test(`the wearer ${wearerPage.name} page fits ${viewport.width}x${viewport.height} without scrolling`, async ({
			page,
			baseURL,
		}) => {
			await page.setViewportSize(viewport);
			await page.addInitScript(() =>
				localStorage.setItem("telly.view", "wearer"),
			);
			if (wearerPage.signedIn) await signIn(page);
			const problems = await watch(page, baseURL);
			await page.goto(wearerPage.path);
			await expect(
				page.getByRole("heading", {
					level: 2,
					name: wearerPage.heading,
					exact: true,
				}),
			).toBeVisible();
			await expect(page.getByText(/^(Next:|Seen )/).first()).toBeVisible();
			const overflow = await page.evaluate(() => ({
				page: document.documentElement.scrollHeight - window.innerHeight,
				desktop: [...document.querySelectorAll(".win95-desktop")].map(
					(e) => e.scrollHeight - e.clientHeight,
				),
			}));
			expect(overflow.page).toBeLessThanOrEqual(0);
			for (const extra of overflow.desktop)
				expect(extra).toBeLessThanOrEqual(0);
			await page.screenshot({
				path: test
					.info()
					.outputPath(
						`${wearerPage.name}-${viewport.width}x${viewport.height}.png`,
					),
				fullPage: true,
			});
			expect(problems).toEqual([]);
		});
