// Runs the agent tools against an in-memory stand-in for the identity's database views. This
// proves family scoping, metric filters, newest-first order, and limits; routes/tools.test.ts
// proves the same views against a real SpacetimeDB.
import { describe, expect, test } from "bun:test";
import { DbUnavailable, type FamilyDb } from "./db";
import { runTool } from "./tools";

const identity = (hex: string) => ({ toHexString: () => hex });
const sampleRow = (
	id: bigint,
	familyId: bigint,
	metric: string,
	at: string,
) => ({
	id,
	familyId,
	metric,
	value: 60,
	unit: "bpm",
	sourceTime: new Date(at),
	receivedAt: new Date(at),
	source: "strap",
	synthetic: false,
	quality: { tag: "Validated" },
});
const alertRow = (id: bigint, familyId: bigint, at: string) => ({
	id,
	familyId,
	sampleId: undefined,
	summary: `alert ${id}`,
	raisedBy: identity("aa"),
	createdAt: new Date(at),
});
const thingRow = (
	id: bigint,
	familyId: bigint,
	person: string,
	place: string,
	at: string,
) => ({
	id,
	familyId,
	personId: identity(person),
	container: "B12 vitamin pills",
	category: "medicine",
	place,
	seenAt: new Date(at),
	notFoundAt: undefined,
});
const ackRow = (id: bigint, alertId: bigint) => ({
	id,
	alertId,
	familyId: 7n,
	member: identity("bb"),
	acknowledgedAt: new Date("2026-01-03T00:00:00Z"),
});

const fakeDb = (
	rows: {
		samples?: unknown[];
		alerts?: unknown[];
		acks?: unknown[];
		things?: unknown[];
	},
	isActive = true,
): FamilyDb => {
	const view = (items: unknown[] = []) => ({ iter: () => items });
	return {
		identity: "cc",
		token: "t",
		connection: {
			isActive,
			db: {
				myFamilies: view(),
				myHealthSamples: view(rows.samples),
				myAlerts: view(rows.alerts),
				myMessages: view(),
				myAcknowledgements: view(rows.acks),
				myMedicineSightings: view(rows.things),
			},
		} as unknown as FamilyDb["connection"],
	};
};

describe("runTool", () => {
	test("health_samples: only the asked family and metric, newest first", () => {
		const db = fakeDb({
			samples: [
				sampleRow(1n, 7n, "heart_rate", "2026-01-01T08:00:00Z"),
				sampleRow(2n, 7n, "heart_rate", "2026-01-02T08:00:00Z"),
				sampleRow(3n, 8n, "heart_rate", "2026-01-03T08:00:00Z"),
				sampleRow(4n, 7n, "sleep_hours", "2026-01-04T08:00:00Z"),
			],
		});
		const filtered = runTool(db, "7", {
			tool: "health_samples",
			input: { metric: "heart_rate" },
		});
		expect(
			filtered.tool === "health_samples" && filtered.samples.map((s) => s.id),
		).toEqual(["2", "1"]);
		const all = runTool(db, "7", { tool: "health_samples", input: {} });
		expect(
			all.tool === "health_samples" && all.samples.map((s) => s.id),
		).toEqual(["4", "2", "1"]);
	});

	test("limit defaults to 20 and keeps the newest", () => {
		const samples = Array.from({ length: 25 }, (_, i) =>
			sampleRow(
				BigInt(i),
				7n,
				"steps",
				new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
			),
		);
		const db = fakeDb({ samples });
		const byDefault = runTool(db, "7", { tool: "health_samples", input: {} });
		expect(
			byDefault.tool === "health_samples" && byDefault.samples.length,
		).toBe(20);
		const two = runTool(db, "7", {
			tool: "health_samples",
			input: { limit: 2 },
		});
		expect(
			two.tool === "health_samples" && two.samples.map((s) => s.id),
		).toEqual(["24", "23"]);
	});

	test("alerts: the family's newest alerts with only their acknowledgements", () => {
		const db = fakeDb({
			alerts: [
				alertRow(1n, 7n, "2026-01-01T00:00:00Z"),
				alertRow(2n, 7n, "2026-01-02T00:00:00Z"),
				alertRow(3n, 8n, "2026-01-03T00:00:00Z"),
			],
			acks: [ackRow(10n, 1n), ackRow(11n, 2n), ackRow(12n, 3n)],
		});
		const response = runTool(db, "7", { tool: "alerts", input: { limit: 1 } });
		expect(response).toEqual({
			tool: "alerts",
			alerts: [
				{
					id: "2",
					familyId: "7",
					sampleId: null,
					summary: "alert 2",
					raisedBy: "aa",
					createdAt: "2026-01-02T00:00:00.000Z",
				},
			],
			acknowledgements: [
				{
					id: "11",
					alertId: "2",
					familyId: "7",
					member: "bb",
					acknowledgedAt: "2026-01-03T00:00:00.000Z",
				},
			],
		});
	});

	test("saved_things: only the asker's own things in the asked family, newest first", () => {
		const db = fakeDb({
			things: [
				thingRow(1n, 7n, "cc", "Hall table", "2026-01-01T08:00:00Z"),
				thingRow(
					2n,
					7n,
					"cc",
					"in the cabinet above the dish rack",
					"2026-01-02T08:00:00Z",
				),
				thingRow(3n, 7n, "dd", "Bedroom", "2026-01-03T08:00:00Z"),
				thingRow(4n, 8n, "cc", "Garage", "2026-01-04T08:00:00Z"),
			],
		});
		expect(runTool(db, "7", { tool: "saved_things", input: {} })).toEqual({
			tool: "saved_things",
			things: [
				{
					id: "2",
					container: "B12 vitamin pills",
					category: "medicine",
					place: "in the cabinet above the dish rack",
					seenAt: "2026-01-02T08:00:00.000Z",
					notFoundAt: null,
				},
				{
					id: "1",
					container: "B12 vitamin pills",
					category: "medicine",
					place: "Hall table",
					seenAt: "2026-01-01T08:00:00.000Z",
					notFoundAt: null,
				},
			],
		});
	});

	test("a closed connection fails instead of returning stale rows", () => {
		const db = fakeDb(
			{ samples: [sampleRow(1n, 7n, "steps", "2026-01-01T00:00:00Z")] },
			false,
		);
		expect(() =>
			runTool(db, "7", { tool: "health_samples", input: {} }),
		).toThrow(DbUnavailable);
	});
});
