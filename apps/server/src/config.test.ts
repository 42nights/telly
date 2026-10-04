import { describe, expect, test } from "bun:test";
import { serverConfig } from "./config";

const base = {
	CORS_ORIGIN: "http://localhost:3001",
	ELEVENLABS_VOICE_ID: "voice",
	ELEVENLABS_API_URL: "http://127.0.0.1:1",
	GEMINI_BASE_URL: "http://127.0.0.1:1",
	REPORT_EMAIL_FROM: "Telly <reports@example.com>",
};

describe("startup configuration", () => {
	test("the fetch bridge needs its URL and token together", () => {
		expect(serverConfig(base).fetchAgent).toBeUndefined();
		expect(
			serverConfig({
				...base,
				TELLY_FETCH_BRIDGE_URL: "https://bridge.test",
				TELLY_FETCH_BRIDGE_TOKEN: "t",
			}).fetchAgent,
		).toEqual({ bridgeUrl: "https://bridge.test", bridgeToken: "t" });
		for (const half of [
			{ TELLY_FETCH_BRIDGE_URL: "https://bridge.test" },
			{ TELLY_FETCH_BRIDGE_TOKEN: "t" },
		])
			expect(() => serverConfig({ ...base, ...half })).toThrow(
				"Set both TELLY_FETCH_BRIDGE_URL and TELLY_FETCH_BRIDGE_TOKEN, or neither",
			);
	});

	test("iMessage maps each allowlisted address to its family", () => {
		expect(serverConfig(base).imessage).toBeUndefined();
		expect(
			serverConfig({
				...base,
				SPECTRUM_PROJECT_ID: "project",
				SPECTRUM_PROJECT_SECRET: "secret",
				SPECTRUM_WEBHOOK_SECRET: "hook",
				TELLY_IMESSAGE_SENDERS: " +15550001111 = 7 ,ana@example.com=12",
			}).imessage,
		).toEqual({
			projectId: "project",
			projectSecret: "secret",
			webhookSecret: "hook",
			senders: new Map([
				["+15550001111", 7n],
				["ana@example.com", 12n],
			]),
			appUrl: "http://localhost:3001",
		});
	});

	test("a partial iMessage setup or a malformed sender list fails startup", () => {
		expect(() =>
			serverConfig({ ...base, SPECTRUM_PROJECT_ID: "project" }),
		).toThrow(
			"Set all of SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, SPECTRUM_WEBHOOK_SECRET, and TELLY_IMESSAGE_SENDERS, or none",
		);
		for (const senders of ["+15550001111", "+1555=seven", "a=1,,b=2"])
			expect(() =>
				serverConfig({
					...base,
					SPECTRUM_PROJECT_ID: "project",
					SPECTRUM_PROJECT_SECRET: "secret",
					SPECTRUM_WEBHOOK_SECRET: "hook",
					TELLY_IMESSAGE_SENDERS: senders,
				}),
			).toThrow("TELLY_IMESSAGE_SENDERS must be address=familyId pairs");
	});

	test("R2 needs all four values and defaults to the account's endpoint", () => {
		const r2 = {
			TELLY_R2_ACCOUNT_ID: "acct",
			TELLY_R2_BUCKET: "reports",
			TELLY_R2_ACCESS_KEY_ID: "id",
			TELLY_R2_SECRET_ACCESS_KEY: "secret",
		};
		expect(serverConfig({ ...base, ...r2 }).r2).toEqual({
			endpoint: "https://acct.r2.cloudflarestorage.com",
			bucket: "reports",
			accessKeyId: "id",
			secretAccessKey: "secret",
		});
		expect(
			serverConfig({ ...base, ...r2, TELLY_R2_ENDPOINT: "http://127.0.0.1:9" })
				.r2?.endpoint,
		).toBe("http://127.0.0.1:9");
		expect(
			serverConfig({ ...base, ...r2, TELLY_R2_BUCKET: "" }).r2,
		).toBeUndefined();
	});

	test("sign-in and the database are all or nothing", () => {
		const signIn = {
			OIDC_ISSUER: "https://issuer.test",
			OIDC_AUDIENCE: "telly",
			SPACETIMEDB_URI: "ws://127.0.0.1:1",
			SPACETIMEDB_DATABASE: "health",
		};
		expect(serverConfig({ ...base, ...signIn }).auth).toEqual({
			issuer: "https://issuer.test",
			audience: "telly",
			clientSecret: undefined,
			db: { uri: "ws://127.0.0.1:1", database: "health" },
		});
		expect(() =>
			serverConfig({ ...base, ...signIn, OIDC_AUDIENCE: undefined }),
		).toThrow("Set all of OIDC_ISSUER");
		expect(() =>
			serverConfig({
				...base,
				...signIn,
				OIDC_ISSUER: undefined,
				OIDC_AUDIENCE: undefined,
			}),
		).toThrow("Set all of OIDC_ISSUER");
	});

	test("NOOP ingest acts as its own database identity for one family", () => {
		const noop = {
			NOOP_INGEST_KEY: "relay-key",
			NOOP_FAMILY_ID: "9",
			NOOP_SPACETIMEDB_TOKEN: "noop-token",
		};
		const db = {
			SPACETIMEDB_URI: "ws://127.0.0.1:1",
			SPACETIMEDB_DATABASE: "health",
		};
		expect(serverConfig({ ...base, ...noop, ...db }).noop).toEqual({
			legacy: { key: "relay-key", familyId: 9n },
			db: { uri: "ws://127.0.0.1:1", database: "health", token: "noop-token" },
		});
		expect(() => serverConfig({ ...base, ...noop })).toThrow(
			"NOOP ingest needs NOOP_SPACETIMEDB_TOKEN, SPACETIMEDB_URI, and SPACETIMEDB_DATABASE",
		);
	});
});
