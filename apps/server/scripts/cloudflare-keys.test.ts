import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serverConfig } from "../src/config";
import { parseEnv, secretNames, serverKeys } from "./cloudflare-keys";
import worker from "./cloudflare-keys-worker";

const secret = (value: string) => ({ get: async () => value });
const pull = "p".repeat(64);
const env = {
	pull_token: secret(pull),
	GEMINI_API_KEY: secret("gemini-test-value"),
	ELEVENLABS_API_KEY: secret("eleven-test-value"),
};
const ask = (
	headers: Record<string, string>,
	method = "GET",
	bindings: Readonly<Record<string, unknown>> = env,
) =>
	worker.fetch(
		new Request("https://secrets.example/", { method, headers }),
		bindings,
	);

describe("telly-secrets Worker", () => {
	test("returns every upper-case secret binding, never the pull token", async () => {
		const response = await ask({ "X-Telly-Pull-Token": pull });
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe(
			"ELEVENLABS_API_KEY=eleven-test-value\nGEMINI_API_KEY=gemini-test-value\n",
		);
	});

	test.each([
		["no token", {}],
		["a wrong token", { "X-Telly-Pull-Token": "q".repeat(64) }],
		["a token prefix", { "X-Telly-Pull-Token": pull.slice(0, 63) }],
		["the token as Authorization", { Authorization: `Bearer ${pull}` }],
	])("refuses %s", async (_, headers) => {
		const response = await ask(headers);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("");
	});

	test("refuses other methods, and serves nothing without a long pull token", async () => {
		expect((await ask({ "X-Telly-Pull-Token": pull }, "POST")).status).toBe(
			403,
		);
		const short = { ...env, pull_token: secret("short") };
		expect(
			(await ask({ "X-Telly-Pull-Token": "short" }, "GET", short)).status,
		).toBe(403);
		const { pull_token: _, ...unbound } = env;
		expect(
			(await ask({ "X-Telly-Pull-Token": pull }, "GET", unbound)).status,
		).toBe(403);
	});
});

describe("key selection", () => {
	const names = secretNames(
		readFileSync(new URL("../.env.schema", import.meta.url), "utf8"),
	);

	test("server keys are the schema items without @public", () => {
		expect(names.has("GEMINI_API_KEY")).toBe(true);
		expect(names.has("ALERT_OPERATOR_TOKEN")).toBe(true);
		expect(names.has("GEMINI_BASE_URL")).toBe(false);
		expect(names.has("TELLY_REQUIRED_KEYS")).toBe(false);
	});

	test("keeps only server keys and refuses an empty or unsafe value by name", () => {
		const keys = serverKeys(
			parseEnv("# note\nGEMINI_API_KEY=AIza-test_1\nPORT=3000\n"),
			names,
		);
		expect([...keys]).toEqual([["GEMINI_API_KEY", "AIza-test_1"]]);
		expect(() => serverKeys(parseEnv("GEMINI_API_KEY="), names)).toThrow(
			"GEMINI_API_KEY is empty",
		);
		const unsafe = () =>
			serverKeys(parseEnv("RIVER_API_KEY=secret value#x"), names);
		expect(unsafe).toThrow("RIVER_API_KEY");
		expect(unsafe).not.toThrow("secret value");
	});
});

describe("TELLY_REQUIRED_KEYS", () => {
	const base = {
		CORS_ORIGIN: "http://localhost:3001",
		ELEVENLABS_VOICE_ID: "voice",
		ELEVENLABS_API_URL: "https://api.elevenlabs.io",
		GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
	};

	test("startup fails with each missing or empty key name", () => {
		expect(() =>
			serverConfig({
				...base,
				GEMINI_API_KEY: "",
				TELLY_REQUIRED_KEYS: "GEMINI_API_KEY, ELEVENLABS_API_KEY",
			}),
		).toThrow(
			"Required keys are missing or empty: GEMINI_API_KEY, ELEVENLABS_API_KEY",
		);
	});

	test("startup succeeds when every listed key is set", () => {
		const config = serverConfig({
			...base,
			GEMINI_API_KEY: "gemini-test-value",
			TELLY_REQUIRED_KEYS: "GEMINI_API_KEY",
		});
		expect(config.gemini?.apiKey).toBe("gemini-test-value");
	});
});
