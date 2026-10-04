// fallow-ignore-file unused-file -- `bun test` runs this file; fallow's bun plugin skips this package.
import { afterAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { urgentRequest } from "../src/ask";
import { type Loaded, loadDecoded } from "../src/index";
import { describeLocation, type SharedLocation } from "../src/location";
import type { MealRecord } from "../src/meal-facts";
import type { ReminderOccurrenceDetail } from "../src/reminders";
import { mealFactText, unresolvedText } from "../src/reports";
import {
	authorizationUrl,
	exchangeSignInCode,
	tokenClaims,
	tokenExpired,
	tokenMatches,
} from "../src/session";

const jwt = (claims: unknown) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

const server = Bun.serve({
	port: 0,
	routes: {
		"/ok": Response.json({ n: 1 }),
		"/bad-shape": Response.json({ n: "x" }),
		"/missing": new Response("no", { status: 404 }),
		"/api/sign-in/token": async (req) => {
			const { code } = (await req.json()) as { code: string };
			if (code === "good") return Response.json({ idToken: "tok" });
			if (code === "known")
				return Response.json(
					{ error: "unauthorized", message: "Code expired" },
					{ status: 401 },
				);
			return new Response("oops", { status: 502 });
		},
	},
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop());

describe("session tokens", () => {
	test("tokenClaims reads a base64url payload and returns null for garbage", () => {
		expect(tokenClaims(jwt({ sub: "ä?>" }))).toEqual({ sub: "ä?>" });
		expect(tokenClaims("no-dots")).toBeNull();
		expect(tokenClaims("a.!!!.b")).toBeNull();
	});

	test.each([
		[{ exp: Date.now() / 1000 - 1 }, true],
		[{ exp: Date.now() / 1000 + 60 }, false],
		[{ sub: "x" }, false],
	])("tokenExpired(%p) is %p", (claims, expired) => {
		expect(tokenExpired(jwt(claims))).toBe(expired);
	});

	test("tokenExpired leaves an unreadable token to the server", () => {
		expect(tokenExpired("garbage")).toBe(false);
	});

	test.each([
		[{ iss: "I", nonce: "N" }, true],
		[{ iss: "other", nonce: "N" }, false],
		[{ iss: "I", nonce: "other" }, false],
		[{ iss: "I" }, false],
	])("tokenMatches(%p) is %p", (claims, ok) => {
		expect(tokenMatches(jwt(claims), "I", "N")).toBe(ok);
	});

	test("authorizationUrl builds a PKCE S256 code request", () => {
		const url = new URL(
			authorizationUrl("https://issuer.test/auth?old=1", {
				clientId: "c",
				redirectUri: "health://sign-in",
				state: "s",
				nonce: "n",
				challenge: "ch",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://issuer.test/auth");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: "code",
			client_id: "c",
			redirect_uri: "health://sign-in",
			scope: "openid email profile",
			access_type: "offline",
			prompt: "consent",
			state: "s",
			nonce: "n",
			code_challenge: "ch",
			code_challenge_method: "S256",
		});
	});

	const request = (code: string) => ({
		code,
		codeVerifier: "v".repeat(43),
		redirectUri: "r",
	});

	test("exchangeSignInCode returns the server's tokens", async () => {
		expect(await exchangeSignInCode(base, request("good"))).toEqual({
			idToken: "tok",
		});
	});

	test("exchangeSignInCode rejects with the server message or the HTTP status", async () => {
		await expect(exchangeSignInCode(base, request("known"))).rejects.toThrow(
			"Code expired",
		);
		await expect(exchangeSignInCode(base, request("other"))).rejects.toThrow(
			"The server replied HTTP 502.",
		);
	});
});

describe("loadDecoded", () => {
	const N = Schema.Struct({ n: Schema.Number });
	const load = (path: string, headers?: Record<string, string>) =>
		new Promise<Loaded<{ readonly n: number }>>((resolve) => {
			loadDecoded(N, `${base}${path}`, resolve, headers);
		});

	test("reports the decoded value", async () => {
		expect(await load("/ok", { Authorization: "Bearer t" })).toEqual({
			kind: "ready",
			value: { n: 1 },
		});
	});

	test("reports HTTP failures and undecodable bodies as errors", async () => {
		expect(await load("/missing")).toEqual({
			kind: "error",
			message: `GET ${base}/missing failed with HTTP 404`,
		});
		const bad = await load("/bad-shape");
		expect(bad.kind).toBe("error");
	});

	test("never reports after cancel", async () => {
		let called = false;
		const cancel = loadDecoded(N, `${base}/ok`, () => {
			called = true;
		});
		cancel();
		// The aborted fetch settles within microtasks; a full round trip after it is a later signal.
		await load("/ok");
		expect(called).toBe(false);
	});
});

describe("describeLocation", () => {
	const now = Date.parse("2026-01-01T12:00:00.000Z");
	const ago = (ms: number) => new Date(now - ms).toISOString();
	const fix = (accuracyMeters = 10, age = 0) => ({
		latitude: 0,
		longitude: 0,
		accuracyMeters,
		fixTime: ago(age),
	});
	const loc = (over: Partial<SharedLocation>): SharedLocation => ({
		familyId: "1",
		sharer: "a".repeat(64),
		status: "fix",
		fix: fix(),
		reportedAt: ago(0),
		...over,
	});

	test.each([
		[
			{ reportedAt: ago(31 * 60_000) },
			"phone_silent",
			"No update from the phone for 31 min. It may be off, out of signal, or not carried.",
		],
		[
			{ reportedAt: ago(3 * 3_600_000) },
			"phone_silent",
			"No update from the phone for 3 h. It may be off, out of signal, or not carried.",
		],
		[
			{ status: "gps_denied", fix: null },
			"gps_denied",
			"Location is turned off on the phone. There is no position.",
		],
		[
			{ status: "gps_denied" },
			"gps_denied",
			"Location is turned off on the phone. Showing the last known position.",
		],
		[{ fix: null }, "no_position", "The phone has not found a position yet."],
		[
			{ status: "no_fix" },
			"no_signal",
			"The phone has no GPS signal now, possibly indoors. Showing the last known position.",
		],
		[
			{ fix: fix(10, 11 * 60_000) },
			"last_known",
			"Last known position, 11 min old.",
		],
		[
			{ fix: fix(150.4) },
			"approximate",
			"Approximate position, within 150 m. Indoors, GPS is often less exact.",
		],
		[{ fix: fix(99.6) }, "current", "Current position, within 100 m."],
	] as const)("%p → %s", (over, kind, text) => {
		const location = loc(over as Partial<SharedLocation>);
		expect(describeLocation(location, now)).toEqual({
			kind,
			text,
			fix: location.fix,
		});
	});

	test("a report from the future counts as under a minute old", () => {
		const location = loc({ reportedAt: ago(0), fix: fix(10, -60_000) });
		expect(describeLocation(location, now - 31 * 60_000 - 1).kind).toBe(
			"current",
		);
		expect(
			describeLocation(loc({ fix: fix(10, 10 * 60_000 + 1) }), now).text,
		).toBe("Last known position, 10 min old.");
	});
});

describe("report text", () => {
	const record = (fact: MealRecord["fact"]): MealRecord => ({
		id: "1",
		fact,
		recordedBy: "a".repeat(64),
		recordedAt: "T1",
	});
	const estimate = (items: never[] | object[]) =>
		record({
			type: "food_estimate",
			estimate: {
				basis: "estimate",
				source: "photo",
				estimator: "gemini",
				estimatedAt: "T0",
				items: items as never,
			},
		});
	const kcal = { low: 1, high: 2 };
	const item = (name: string) => ({
		name,
		preparation: null,
		portion: "1 cup",
		energyKcal: kcal,
		proteinG: kcal,
		carbohydrateG: kcal,
		fatG: kcal,
	});

	test.each([
		[
			record({ type: "photo_taken", capturedAt: "T0" }),
			"Photo taken at T0. The photo is not kept.",
		],
		[
			estimate([]),
			"Estimate from a photo by gemini at T0, not a measurement: no food found.",
		],
		[
			estimate([item("rice"), item("beans")]),
			"Estimate from a photo by gemini at T0, not a measurement: rice, 1 cup, 1-2 kcal; beans, 1 cup, 1-2 kcal.",
		],
		[
			record({
				type: "intake_report",
				kind: "meal",
				amount: "some",
				reportedBy: "wearer",
				words: null,
				via: "tap",
			}),
			"The wearer reported the meal amount as some at T1.",
		],
		[
			record({
				type: "intake_report",
				kind: "drink",
				amount: "all",
				reportedBy: "caregiver",
				words: "all gone",
				via: "voice",
			}),
			'The caregiver reported the drink amount as all, saying "all gone" at T1.',
		],
		[
			record({ type: "caregiver_assistance", help: "cut the food" }),
			"A caregiver helped: cut the food, at T1.",
		],
	])("mealFactText %#", (r, text) => {
		expect(mealFactText(r)).toBe(text);
	});

	const detail = (wordings: (string | null)[]) =>
		({
			occurrence: { title: "Pills", kind: "medication", scheduledFor: "T2" },
			events: wordings.map((wording) => ({ wording })),
		}) as unknown as ReminderOccurrenceDetail;

	test.each([
		[[], "Pills (medication reminder for T2): unresolved."],
		[
			["first", "later", null],
			'Pills (medication reminder for T2): unresolved. Last words: "later".',
		],
	])("unresolvedText %#", (wordings, text) => {
		expect(unresolvedText(detail(wordings))).toBe(text);
	});
});

describe("urgentRequest", () => {
	test.each([
		["Help!", "en"],
		["I fell in the kitchen", "en"],
		["I can’t breathe", "en"],
		["please call an ambulance", "en"],
		["Me caí y no puedo levantarme", "es"],
		["¡Socorro!", "es"],
		["I fell asleep after lunch", null],
		["What did I eat today?", null],
	])("%p → %p", (text, language) => {
		expect(urgentRequest(text)).toBe(language as "en" | "es" | null);
	});
});
