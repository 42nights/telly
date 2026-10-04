// Layout smoke test (captain: "it should fill the box its in ... if its too big then thats probably
// a sign to compact or break it apart"): no page scrolls as a whole at two desktop sizes and on a
// phone. Only long lists scroll, inside their own box. Wearer Home is out of scope here.
import { expect, test } from "@playwright/test";

import { family, replies, signIn, watch } from "./fake-api";

const now = Date.now();
const iso = (hoursAgo: number) =>
	new Date(now - hoursAgo * 3_600_000).toISOString();
let id = 0;
const reading = (
	metric: string,
	value: number,
	unit: string,
	hoursAgo: number,
) => ({
	id: String(++id),
	familyId: "1",
	metric,
	value,
	unit,
	sourceTime: iso(hoursAgo),
	receivedAt: iso(hoursAgo),
	source: "noop:my-whoop-noop",
	synthetic: false,
	quality: "unvalidated",
});

// A family with a WHOOP's daily scores, so the Family overview is as full as it gets in use.
const routes: Record<string, unknown> = {
	...replies,
	"/api/sources": {
		sources: [{ source: "noop", status: "connected", lastSeenAt: iso(0) }],
	},
	"/api/families/1": {
		families: [family],
		samples: [
			reading("heart_rate", 55, "bpm", 4),
			reading("on_wrist", 1, "boolean", 4),
			reading("hrv", 104, "ms", 37),
			reading("resting_heart_rate", 52, "bpm", 37),
			reading("respiratory_rate", 14.2, "breaths/min", 37),
			reading("sleep_duration", 536.6, "min", 37),
			reading("sleep_efficiency", 91, "%", 37),
			reading("daily_strain", 0, "noop effort (0-100)", 37),
			reading("recovery", 78, "%", 37),
			reading("skin_temperature", 33.4, "°C", 37),
			reading("daily_steps", 4210, "steps", 37),
		],
		alerts: [],
		messages: [],
		acknowledgements: [],
	},
};

const paths = [
	"/family",
	"/family/daily",
	"/family/exercise",
	"/family/cooking",
	"/family/alerts",
	"/family/trends",
	"/family/thresholds",
	"/chat",
	"/care",
	"/care/contacts",
	"/care/plan",
	"/care/facts",
	"/care/sharing",
	"/appointments",
	"/reports",
	"/find",
	"/trip",
	"/meal",
	"/cooking",
	"/settings",
	"/settings/text-telly",
	"/settings/speaker",
	"/settings/going-out",
	"/settings/things",
	"/settings/reports",
	"/settings/device",
	"/settings/demo",
	"/settings/family",
];

// The wearer view has its own menu and Settings rows, so its screens are checked in that view too.
const wearerPaths = ["/find", "/trip", "/settings"];

// Open product decision (PR #314): the big-button Meal screen does not fit a 390 px phone without
// a redesign into steps. Desktop sizes are checked; the phone is not yet.
const phonePending = ["/meal"];

for (const [width, height] of [
	[1440, 900],
	[1280, 800],
	[390, 844],
] as const)
	for (const view of ["family", "wearer"] as const)
		test(`no page scrolls as a whole at ${width}x${height} in the ${view} view`, async ({
			page,
			baseURL,
		}) => {
			// One test walks every route and waits for each to settle.
			test.setTimeout(180_000);
			await page.setViewportSize({ width, height });
			await signIn(page);
			await page.addInitScript(
				(chosen) => localStorage.setItem("telly.view", chosen),
				view,
			);
			await watch(page, baseURL, routes);
			const overflow: string[] = [];
			for (const path of view === "family" ? paths : wearerPaths) {
				if (width === 390 && phonePending.includes(path)) continue;
				await page.goto(path);
				// Every read has answered and the screen has its final content, then measure.
				await page.waitForLoadState("networkidle");
				await expect(page.getByText("Waiting for the server.")).toHaveCount(0);
				await expect(page.getByText(/^Loading /)).toHaveCount(0);
				const extra = await page.evaluate(() => {
					const desktop = document.querySelector(".win95-desktop");
					return Math.max(
						document.documentElement.scrollHeight - window.innerHeight,
						desktop === null ? 0 : desktop.scrollHeight - desktop.clientHeight,
					);
				});
				if (extra > 1) overflow.push(`${path} scrolls by ${extra} px`);
			}
			expect(overflow).toEqual([]);
		});
