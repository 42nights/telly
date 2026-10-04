// The fake server for the browser smoke tests: the session (an unsigned JWT-shaped ID token with a
// future `exp`, stored where the sign-in screen stores it) and the whole server API (`page.route` on
// VITE_SERVER_URL). Every other non-app request is blocked and reported as a problem.
import type { FamilyList, FamilyMembers, Me } from "@health/contracts/families";
import type { Page } from "@playwright/test";

import { SERVER_URL } from "../playwright.config";

export const family = {
	id: "1",
	name: "Smoke Family",
	createdAt: "2026-01-01T00:00:00.000Z",
};

// Empty-but-valid replies, in the shape of each contract the tabs decode.
export const replies: Record<string, unknown> = {
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
		alerts: [],
		messages: [],
		acknowledgements: [],
	},
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
	"/api/families/1/reminder-occurrences": { occurrences: [] },
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
		permission: null,
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
	"/api/families/1/report-pdfs": { pdfs: [] },
	"/api/families/1/appointments": { appointments: [] },
};

/** Serves the app, fakes the API from `routes`, and collects page errors and blocked requests. */
export const watch = async (
	page: Page,
	baseURL: string | undefined,
	routes: Record<string, unknown> = replies,
) => {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(`page error: ${error}`));
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin === SERVER_URL) {
			const body = routes[url.pathname];
			if (route.request().method() === "GET" && body !== undefined)
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

/** Signs the page in before any app code runs. */
export const signIn = (page: Page) =>
	// `eyJhbGciOiJSUzI1NiJ9` is `{"alg":"RS256"}`; the app reads only the payload's `exp`.
	page.addInitScript(() => {
		sessionStorage.setItem(
			"telly.session.token",
			`eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ sub: "smoke-user", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`,
		);
	});
