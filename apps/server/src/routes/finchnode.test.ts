// Runs against a real local SpacetimeDB (`bun run db:test`) and a local protocol server that answers
// like FinchNode's documented API (https://finchnode.com/openapi.yaml). It proves request shapes and
// response handling only; it is not a FinchNode round trip. All data is synthetic.
import { afterAll, describe, expect, test } from "bun:test";
import { FinchnodeLabs, FinchnodeSession } from "@health/contracts/reports";
import { Effect, Schema } from "effect";
import { openFamilyDb } from "../db";
import type { Finchnode } from "../integrations/finchnode";
import { finchnodeRoutes } from "./finchnode";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const own = `cs_${"a".repeat(20)}`;
const foreign = `cs_${"b".repeat(20)}`;
const subject = "u_00000000000000a1";
let familyId = "";
let records: { status: number; body: unknown } = { status: 200, body: {} };
const seen: string[] = [];

const lab = {
	id: "rec_000000000000000000000001",
	resourceType: "Observation",
	sourceRecordId: "Observation/syn-a1c",
	source: "synthetic-ehr",
	sourceName: "Synthetic Health System",
	codes: [
		{ system: "http://loinc.org", code: "4548-4", display: "Hemoglobin A1c" },
	],
	sourceUpdatedAt: "2026-08-25T16:58:00Z",
	syncedAt: "2026-08-25T17:00:00Z",
	name: "Hemoglobin A1c",
	value: "6.4",
	unit: "%",
	status: "final",
	date: "2026-07-18T15:30:00Z",
	referenceRange: "Synthetic reference: below 5.7%",
	interpretation: "H",
	performer: "Synthetic Health System",
};
const record = {
	sources: [
		{
			system: "synthetic-ehr",
			organization: "Synthetic Health System",
			lastSyncedAt: "2026-08-25T17:00:00Z",
		},
	],
	data: { labs: [lab] },
	meta: {
		syncStatus: "partial",
		dataAsOf: "2026-08-25T17:00:00Z",
		warnings: [{ code: "source_unavailable", message: "x", retryable: true }],
	},
};

const protocol = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const { pathname } = new URL(request.url);
		seen.push(
			`${request.method} ${pathname} ${request.headers.get("authorization")}`,
		);
		if (request.method === "POST" && pathname === "/connect/sessions") {
			const body = (await request.json()) as { externalId: string };
			return Response.json(
				{
					id: own,
					url: `https://connect.invalid/${own}`,
					status: "pending",
					externalId: body.externalId,
				},
				{ status: 201 },
			);
		}
		if (pathname === `/connect/sessions/${own}`)
			return Response.json({
				status: "completed",
				subject,
				externalId: familyId,
			});
		if (pathname === `/connect/sessions/${foreign}`)
			return Response.json({
				status: "completed",
				subject: "u_00000000000000b2",
				externalId: "another-family",
			});
		if (pathname === `/users/${subject}/records`)
			return Response.json(records.body, { status: records.status });
		return Response.json({ error: { code: "not_found" } }, { status: 404 });
	},
});
afterAll(() => protocol.stop());

const finchnode: Finchnode = {
	kind: "api",
	baseUrl: `http://127.0.0.1:${protocol.port}`,
	apiKey: "ck_test_protocol",
	synthetic: true,
};

describe.skipIf(dbConfig === undefined)("Finchnode records", () => {
	test("a family links only its own finished session and reads its labs with source and consent state", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const family = yield* openFamily(config, "Finchnode family");
				familyId = family.familyId;
				const app = familyApp(family.db, familyId, finchnodeRoutes(finchnode));

				const started = yield* send(app, "POST", "/finchnode/sessions");
				expect(started.status).toBe(201);
				expect(
					Schema.decodeUnknownSync(FinchnodeSession)(started.json),
				).toEqual({
					sessionId: own,
					url: `https://connect.invalid/${own}`,
					linked: false,
					synthetic: true,
				});
				expect(seen[0]).toBe("POST /connect/sessions Bearer ck_test_protocol");

				const stolen = yield* send(
					app,
					"POST",
					`/finchnode/sessions/${foreign}/link`,
				);
				expect(failure(stolen)).toEqual([404, "not_found"]);
				const linked = yield* send(
					app,
					"POST",
					`/finchnode/sessions/${own}/link`,
				);
				expect(
					Schema.decodeUnknownSync(FinchnodeSession)(linked.json).linked,
				).toBe(true);

				records = { status: 200, body: record };
				const labs = yield* send(app, "GET", "/finchnode/labs");
				const [granted] = Schema.decodeUnknownSync(FinchnodeLabs)(labs.json, {
					onExcessProperty: "error",
				}).subjects;
				expect(granted).toMatchObject({
					subject,
					synthetic: true,
					access: "granted",
					syncStatus: "partial",
					warnings: ["source_unavailable"],
					sources: record.sources,
				});
				const { performer: _, resourceType: __, ...kept } = lab;
				expect(granted?.labs).toEqual([kept]);

				records = {
					status: 410,
					body: { error: { code: "consent_inactive" } },
				};
				const revoked = yield* send(app, "GET", "/finchnode/labs");
				expect(
					Schema.decodeUnknownSync(FinchnodeLabs)(revoked.json).subjects,
				).toMatchObject([{ subject, access: "inactive", labs: [] }]);

				records = { status: 200, body: { data: { labs: "not a list" } } };
				const malformed = yield* send(app, "GET", "/finchnode/labs");
				expect(failure(malformed)).toEqual([502, "upstream_error"]);
				records = { status: 429, body: {} };
				const limited = yield* send(app, "GET", "/finchnode/labs");
				expect(failure(limited)).toEqual([503, "unavailable"]);

				const offApp = familyApp(
					family.db,
					familyId,
					finchnodeRoutes(undefined),
				);
				const off = yield* send(offApp, "GET", "/finchnode/labs");
				expect(failure(off)).toEqual([503, "unavailable"]);
			}),
		));

	test("another family's identity cannot link a subject to the family", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { familyId: id } = yield* openFamily(config, "Linked family");
				const outsider = yield* openFamilyDb(config);
				const result = yield* Effect.promise(() =>
					outsider.connection.reducers
						.linkFinchnodeSubject({
							familyId: BigInt(id),
							subject,
							synthetic: true,
						})
						.then(String, String),
				);
				expect(result).toBe("SenderError: not a member of this family");
			}),
		));
});
