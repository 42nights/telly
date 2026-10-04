// The fake server for the browser smoke tests: the session (an unsigned JWT-shaped ID token with a
// future `exp`, stored where the sign-in screen stores it) and the whole server API (`page.route` on
// VITE_SERVER_URL). Every other non-app request is blocked and reported as a problem.
import type { FamilyRecords } from "@health/contracts";
import type {
	FamilyList,
	FamilyMembers,
	Me,
	TextTelly,
} from "@health/contracts/families";
import type { LinkedFinder } from "@health/contracts/finder-link";
import type { ReminderHistory } from "@health/contracts/reminders";
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
	"/api/text-telly": {
		tellyNumber: "+15550100123",
		myPhone: null,
	} satisfies TextTelly,
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
	"/api/families/1/location": {
		locations: [],
		shares: [],
		seesShared: false,
		events: [],
	},
	"/api/families/1/location/home": {
		home: null,
		radiusMeters: 200,
		autoTrip: false,
		awaySince: null,
		distanceMeters: null,
		sharing: false,
	},
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
	"/api/families/1/report-pdfs": { pdfs: [] },
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
			const method = route.request().method();
			const body = (method === "POST" ? posts : routes)[url.pathname];
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

/** Signs the page in before any app code runs. */
export const signIn = (page: Page) =>
	// `eyJhbGciOiJSUzI1NiJ9` is `{"alg":"RS256"}`; the app reads only the payload's `exp`.
	page.addInitScript(() => {
		sessionStorage.setItem(
			"telly.session.token",
			`eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ sub: "smoke-user", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`,
		);
	});
