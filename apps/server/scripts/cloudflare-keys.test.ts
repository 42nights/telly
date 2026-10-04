import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serverConfig } from "../src/config";
import { parseEnv, secretNames, serverKeys } from "./cloudflare-keys";
import worker from "./cloudflare-keys-worker";

const team = "telly.cloudflareaccess.com";
const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const { publicKey, privateKey } = await crypto.subtle.generateKey(
	{ ...algo, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
	true,
	["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const b64 = (data: string) => Buffer.from(data).toString("base64url");

const jwt = async (claims: Record<string, unknown>) => {
	const signed = `${b64(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64(JSON.stringify(claims))}`;
	const sig = await crypto.subtle.sign(
		algo,
		privateKey,
		new TextEncoder().encode(signed),
	);
	return `${signed}.${Buffer.from(sig).toString("base64url")}`;
};

const secret = (value: string) => ({ get: async () => value });
const env = {
	team_domain: team,
	aud: "app-aud",
	client_id: "pull.access",
	GEMINI_API_KEY: secret("gemini-test-value"),
	ELEVENLABS_API_KEY: secret("eleven-test-value"),
};
const valid = {
	iss: `https://${team}`,
	aud: ["app-aud"],
	exp: Date.now() / 1000 + 60,
	common_name: "pull.access",
};
const call = async (claims: Record<string, unknown>, method = "GET") =>
	worker.fetch(
		new Request("https://secrets.example/", {
			method,
			headers: { "Cf-Access-Jwt-Assertion": await jwt(claims) },
		}),
		env,
	);

describe("telly-secrets Worker", () => {
	afterEach(() => spyOn(globalThis, "fetch").mockRestore());
	const certs = () =>
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ keys: [jwk] }),
		);

	test("returns every bound secret to the pull service token", async () => {
		certs();
		const response = await call(valid);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe(
			"ELEVENLABS_API_KEY=eleven-test-value\nGEMINI_API_KEY=gemini-test-value\n",
		);
	});

	test.each([
		["another service token", { ...valid, common_name: "other.access" }],
		["another Access app", { ...valid, aud: ["other-aud"] }],
		["another team", { ...valid, iss: "https://evil.cloudflareaccess.com" }],
		["an expired token", { ...valid, exp: Date.now() / 1000 - 1 }],
	])("refuses %s", async (_, claims) => {
		certs();
		expect((await call(claims)).status).toBe(403);
	});

	test("refuses a forged signature, a missing JWT, and other methods", async () => {
		certs();
		const [head, , sig] = (await jwt(valid)).split(".");
		const forged = `${head}.${b64(JSON.stringify({ ...valid, aud: "x" }))}.${sig}`;
		const ask = (headers: Record<string, string>) =>
			worker.fetch(new Request("https://secrets.example/", { headers }), env);
		expect((await ask({ "Cf-Access-Jwt-Assertion": forged })).status).toBe(403);
		expect((await ask({})).status).toBe(403);
		expect((await call(valid, "POST")).status).toBe(403);
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
