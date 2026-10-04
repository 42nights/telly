import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	createSession,
	type Finchnode,
	finchnodeFromEnv,
	sessionSubject,
	subjectLabs,
} from "./finchnode";

// Test-only stand-in for the FinchNode API: it records each request and answers with `reply`.
type Seen = {
	method: string;
	path: string;
	headers: Headers;
	body: unknown;
};
let seen: Seen[] = [];
let reply: () => Response = () => Response.json({});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const url = new URL(request.url);
		const text = await request.text();
		seen.push({
			method: request.method,
			path: `${url.pathname}${url.search}`,
			headers: request.headers,
			body: text === "" ? undefined : JSON.parse(text),
		});
		return reply();
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	seen = [];
});

const base = `${server.url.origin}/v1`;
const api: Finchnode = {
	kind: "api",
	baseUrl: base,
	apiKey: "ck_live_x",
	synthetic: false,
};
const demo: Finchnode = {
	kind: "demo",
	baseUrl: base,
	apiKey: undefined,
	synthetic: true,
};
const signal = new AbortController().signal;

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string; code: string; message: string }) => [
			error.name,
			error.code,
			error.message,
		],
	);

describe("finchnodeFromEnv", () => {
	test("off is no FinchNode", () => {
		expect(finchnodeFromEnv("off", "ck_live_x")).toBeUndefined();
	});

	test("demo uses the keyless demo API and is synthetic, whatever the key", () => {
		expect(finchnodeFromEnv("demo", "ck_live_x")).toEqual({
			kind: "demo",
			baseUrl: "https://api.finchnode.com/demo/v1",
			apiKey: undefined,
			synthetic: true,
		});
	});

	test("api needs a key", () => {
		expect(() => finchnodeFromEnv("api", undefined)).toThrow(
			"FINCHNODE_MODE=api needs FINCHNODE_API_KEY",
		);
		expect(() => finchnodeFromEnv("api", "")).toThrow(
			"FINCHNODE_MODE=api needs FINCHNODE_API_KEY",
		);
	});

	test("api is synthetic only with a test key", () => {
		expect(finchnodeFromEnv("api", "ck_live_x")).toEqual({
			kind: "api",
			baseUrl: "https://api.finchnode.com/api/v1",
			apiKey: "ck_live_x",
			synthetic: false,
		});
		expect(finchnodeFromEnv("api", "ck_test_x")?.synthetic).toBe(true);
	});
});

describe("createSession", () => {
	test("demo posts the family as external_user_id and returns the finished subject", async () => {
		reply = () =>
			Response.json(
				{
					id: "demo_1",
					status: "complete",
					patient_id: "pat_demo",
					connect_url: "https://demo/connect",
				},
				{ status: 201 },
			);
		expect(await createSession(demo, "42", signal)).toEqual({
			sessionId: "demo_1",
			url: "https://demo/connect",
			subject: "pat_demo",
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.path).toBe("/v1/connect/sessions");
		expect(seen[0]?.body).toEqual({
			external_user_id: "family-42",
			categories: ["labs"],
		});
		expect(seen[0]?.headers.get("authorization")).toBeNull();
		expect(seen[0]?.headers.get("content-type")).toBe("application/json");
	});

	test("demo errors: a status other than 201, or an unfinished session", async () => {
		reply = () => Response.json({}, { status: 500 });
		expect(await failure(createSession(demo, "42", signal))).toEqual([
			"ApiFailure",
			"unavailable",
			"Finchnode answered HTTP 500",
		]);
		reply = () =>
			Response.json(
				{ id: "d", status: "pending", patient_id: "p", connect_url: "u" },
				{ status: 201 },
			);
		expect(await failure(createSession(demo, "42", signal))).toEqual([
			"ApiFailure",
			"upstream_error",
			"Finchnode sent an unexpected response",
		]);
	});

	test("api posts externalId with the bearer key and returns no subject yet", async () => {
		reply = () =>
			Response.json({ id: "cs_1", url: "https://connect/1" }, { status: 201 });
		expect(await createSession(api, "42", signal)).toEqual({
			sessionId: "cs_1",
			url: "https://connect/1",
			subject: null,
		});
		expect(seen[0]?.body).toEqual({ externalId: "42", categories: ["labs"] });
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer ck_live_x");
	});

	test("api: a client error is upstream_error, a non-JSON 201 is unexpected", async () => {
		reply = () => Response.json({}, { status: 400 });
		expect((await failure(createSession(api, "42", signal)))?.[1]).toBe(
			"upstream_error",
		);
		reply = () => new Response("not json", { status: 201 });
		expect((await failure(createSession(api, "42", signal)))?.[2]).toBe(
			"Finchnode sent an unexpected response",
		);
	});

	test("an unreachable or aborted call is unavailable", async () => {
		const baseUrl = "http://127.0.0.1:1"; // nothing listens on port 1
		expect(
			await failure(createSession({ ...api, baseUrl }, "42", signal)),
		).toEqual(["ApiFailure", "unavailable", "Finchnode did not respond"]);
		expect(
			(await failure(createSession(api, "42", AbortSignal.abort())))?.[2],
		).toBe("Finchnode did not respond");
	});
});

describe("sessionSubject", () => {
	const id = "cs_0123456789abcdef0123";
	const session = (status: string, externalId: string | null) => () =>
		Response.json({ status, subject: "pat_1", externalId });

	test("demo and malformed ids never reach FinchNode", async () => {
		expect(await sessionSubject(demo, id, "42", signal)).toBeUndefined();
		for (const bad of ["cs_123", "cs_0123456789ABCDEF0123", "../users/x"])
			expect(await sessionSubject(api, bad, "42", signal)).toBeUndefined();
		expect(seen).toHaveLength(0);
	});

	test("a completed session of this family returns its subject via GET", async () => {
		reply = session("completed", "42");
		expect(await sessionSubject(api, id, "42", signal)).toBe("pat_1");
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.path).toBe(`/v1/connect/sessions/${id}`);
		expect(seen[0]?.headers.get("content-type")).toBeNull();
	});

	test("an unfinished session is null; another family's session is undefined", async () => {
		reply = session("pending", "42");
		expect(await sessionSubject(api, id, "42", signal)).toBeNull();
		reply = session("completed", "43");
		expect(await sessionSubject(api, id, "42", signal)).toBeUndefined();
	});

	test("404 is undefined; another status is an error", async () => {
		reply = () => Response.json({}, { status: 404 });
		expect(await sessionSubject(api, id, "42", signal)).toBeUndefined();
		reply = () => Response.json({}, { status: 429 });
		expect((await failure(sessionSubject(api, id, "42", signal)))?.[1]).toBe(
			"unavailable",
		);
	});
});

describe("subjectLabs", () => {
	const lab = {
		id: "lab_1",
		name: "HbA1c",
		value: 6.1,
		unit: "%",
		status: "final",
		date: "2026-09-01",
		referenceRange: "4.0-5.6",
		interpretation: "high",
		source: "epic",
		sourceName: "Clinic",
		sourceRecordId: "r1",
		codes: [{ system: "loinc", code: "4548-4", display: "HbA1c" }],
		sourceUpdatedAt: null,
		syncedAt: null,
	};
	const record = (labs?: unknown[]) => ({
		sources: [{ system: "epic", organization: "Clinic", lastSyncedAt: null }],
		data: labs === undefined ? {} : { labs },
		meta: {
			syncStatus: "partial",
			dataAsOf: "2026-09-02",
			warnings: [{ code: "source_unavailable" }],
		},
	});
	const empty = (access: "inactive" | "not_granted") => ({
		subject: "pat/1",
		synthetic: false,
		access,
		syncStatus: null,
		dataAsOf: null,
		warnings: [],
		sources: [],
		labs: [],
	});

	test("granted labs carry sources, sync state, and warning codes", async () => {
		reply = () => Response.json(record([lab]));
		expect(await subjectLabs(api, "pat/1", signal)).toEqual({
			subject: "pat/1",
			synthetic: false,
			access: "granted",
			syncStatus: "partial",
			dataAsOf: "2026-09-02",
			warnings: ["source_unavailable"],
			sources: [{ system: "epic", organization: "Clinic", lastSyncedAt: null }],
			labs: [lab],
		});
		expect(seen[0]?.path).toBe("/v1/users/pat%2F1/records?categories=labs");
	});

	test("a record without labs is an empty list", async () => {
		reply = () => Response.json(record());
		expect((await subjectLabs(demo, "pat/1", signal)).labs).toEqual([]);
		expect((await subjectLabs(demo, "pat/1", signal)).synthetic).toBe(true);
	});

	test("410 is inactive and a labs-scope 403 is not_granted", async () => {
		reply = () => Response.json({}, { status: 410 });
		expect(await subjectLabs(api, "pat/1", signal)).toEqual(empty("inactive"));
		reply = () =>
			Response.json(
				{ error: { code: "consent_scope_exceeded" } },
				{ status: 403 },
			);
		expect(await subjectLabs(api, "pat/1", signal)).toEqual(
			empty("not_granted"),
		);
	});

	test("another 403 or status is an error; a bad record is unexpected", async () => {
		reply = () =>
			Response.json({ error: { code: "forbidden" } }, { status: 403 });
		expect(await failure(subjectLabs(api, "pat/1", signal))).toEqual([
			"ApiFailure",
			"upstream_error",
			"Finchnode answered HTTP 403",
		]);
		reply = () => Response.json({}, { status: 502 });
		expect((await failure(subjectLabs(api, "pat/1", signal)))?.[1]).toBe(
			"unavailable",
		);
		reply = () => Response.json({ ...record(), sources: "x" });
		expect((await failure(subjectLabs(api, "pat/1", signal)))?.[2]).toBe(
			"Finchnode sent an unexpected response",
		);
	});
});
