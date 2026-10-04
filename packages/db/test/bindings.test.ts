// fallow-ignore-file unused-file -- `bun test` runs this file; fallow's bun plugin skips this package.
import { describe, expect, test } from "bun:test";
import {
	BinaryReader,
	BinaryWriter,
	Identity,
	ScheduleAt,
	Timestamp,
	type TypeBuilder,
	t,
} from "spacetimedb";
import { DbConnection, reducers, SubscriptionBuilder } from "../src/index";
import MyAlertDeliveriesRow from "../src/my_alert_deliveries_table";
import MyAlertThresholdsRow from "../src/my_alert_thresholds_table";
import MyCareNeedsRow from "../src/my_care_needs_table";
import MyContactAttemptsRow from "../src/my_contact_attempts_table";
import MyContactLaddersRow from "../src/my_contact_ladders_table";
import MyDeliveryEventsRow from "../src/my_delivery_events_table";
import MyHealthSamplesRow from "../src/my_health_samples_table";
import MyLocationsRow from "../src/my_locations_table";
import MyTripEventsRow from "../src/my_trip_events_table";
import PendingAlertDeliveriesRow from "../src/pending_alert_deliveries_table";
import * as T from "../src/types";

// biome-ignore lint/suspicious/noExplicitAny: generated builders are heterogeneous
type Builder = TypeBuilder<any, any>;

const encode = (type: Builder, value: unknown) => {
	const writer = new BinaryWriter(256);
	type.serialize(writer, value);
	return writer.getBuffer();
};
const decode = (type: Builder, bytes: Uint8Array) =>
	type.deserialize(new BinaryReader(bytes));

const alice = Identity.fromString("11".repeat(32));
const bob = Identity.fromString("22".repeat(32));
const t0 = Timestamp.fromDate(new Date("2026-01-05T12:00:00Z"));
const t1 = Timestamp.fromDate(new Date("2026-01-05T12:05:00Z"));

const step = {
	member: alice,
	name: "Ana",
	timeZone: "Europe/Lisbon",
	detail: { tag: "Facts" },
	callFor: [{ tag: "Alert" }, { tag: "CallReminder" }],
};

const careNeed = {
	id: 7n,
	familyId: 1n,
	kind: { tag: "Help" },
	summary: "Fell in kitchen",
	facts: [
		{ text: "HR 120", source: "watch", observedAt: t0, uncertainty: "low" },
	],
	alertId: 3n,
	dueAt: t1,
	steps: [step],
	hasBackup: true,
	answerSeconds: 60,
	followUpSeconds: 300,
	status: { tag: "Accepted" },
	step: 1,
	acceptedBy: bob,
	followUpBy: undefined,
	raisedBy: alice,
	clientId: "c-1",
	createdAt: t0,
	updatedAt: t1,
};

const alertDelivery = {
	alertId: 3n,
	familyId: 1n,
	summary: "HR high",
	status: { tag: "Failed" },
	attempts: 2,
	notBefore: t1,
	lastError: "timeout",
	updatedAt: t0,
};

// Each pair: the server's table row layout and the client type of the same row.
const rowCases: [string, Builder, Builder, Record<string, unknown>][] = [
	["CareNeed", MyCareNeedsRow, T.CareNeed, careNeed],
	["AlertDelivery", MyAlertDeliveriesRow, T.AlertDelivery, alertDelivery],
	[
		"PendingDelivery",
		PendingAlertDeliveriesRow,
		T.PendingDelivery,
		{
			alertId: 3n,
			familyId: 1n,
			summary: "HR high",
			status: { tag: "Unavailable" },
			attempts: 0,
			notBefore: t0,
			updatedAt: t0,
		},
	],
	[
		"AlertThreshold",
		MyAlertThresholdsRow,
		T.AlertThreshold,
		{
			id: 1n,
			familyId: 1n,
			metric: "heart_rate",
			direction: { tag: "Below" },
			limit: 40.5,
			unit: "bpm",
			maxAgeSeconds: 600,
			updatedBy: alice,
			updatedAt: t0,
		},
	],
	[
		"ContactAttempt",
		MyContactAttemptsRow,
		T.ContactAttempt,
		{
			key: "7:1:aa",
			needId: 7n,
			familyId: 1n,
			step: 1,
			member: bob,
			channel: { tag: "Message" },
			status: { tag: "FollowUpExpired" },
			body: "Can you check on Mum?",
			createdAt: t0,
			updatedAt: t1,
		},
	],
	[
		"ContactLadder",
		MyContactLaddersRow,
		T.ContactLadder,
		{
			familyId: 1n,
			contacts: [
				step,
				{ ...step, member: bob, detail: { tag: "Minimal" }, callFor: [] },
			],
			backup: { ...step, name: "Neighbour", detail: { tag: "Summary" } },
			answerSeconds: 90,
			followUpSeconds: 900,
			updatedBy: alice,
			updatedAt: t0,
		},
	],
	[
		"DeliveryEvent",
		MyDeliveryEventsRow,
		T.DeliveryEvent,
		{
			id: 4n,
			familyId: 1n,
			proposalId: "p-1",
			status: { tag: "Eaten" },
			proposal: undefined,
			note: "all gone",
			actor: alice,
			at: t1,
		},
	],
	[
		"HealthSample",
		MyHealthSamplesRow,
		T.HealthSample,
		{
			id: 9n,
			familyId: 1n,
			metric: "spo2",
			value: 97.25,
			unit: "%",
			sourceTime: t0,
			receivedAt: t1,
			source: "finchnode",
			synthetic: false,
			quality: { tag: "Unvalidated" },
			recordedBy: alice,
		},
	],
	[
		"Location",
		MyLocationsRow,
		T.Location,
		{
			id: 2n,
			familyId: 1n,
			sharer: alice,
			status: { tag: "Fix" },
			fix: {
				latitude: 38.72,
				longitude: -9.14,
				accuracyMeters: 12,
				fixTime: t0,
			},
			reportedAt: t1,
		},
	],
	[
		"TripEvent",
		MyTripEventsRow,
		T.TripEvent,
		{
			id: 5n,
			familyId: 1n,
			tripId: "trip-1",
			step: { tag: "Arrived" },
			source: "phone",
			purpose: "GP visit",
			destination: undefined,
			notifyDeparture: true,
			notifyArrival: false,
			by: bob,
			at: t1,
		},
	],
];

describe("generated row types", () => {
	test.each(rowCases)(
		"%s: a server table row decodes into the client type unchanged",
		(_, tableRow, clientType, value) => {
			const bytes = encode(tableRow, value);
			expect(encode(clientType, value)).toEqual(bytes);
			// Unit variants decode as `{ tag, value: {} }`; every sent field must come back.
			expect(decode(clientType, bytes)).toMatchObject(value);
		},
	);

	test("enum fields encode as their declared variant index", () => {
		const statuses = ["Open", "Accepted", "Resolved", "Unresolved"];
		for (const [i, tag] of statuses.entries()) {
			expect([...encode(T.NeedStatus, { tag })]).toEqual([i]);
		}
		const resolved = decode(
			T.CareNeed,
			encode(T.CareNeed, { ...careNeed, status: { tag: "Resolved" } }),
		);
		expect(resolved.status.tag).toBe("Resolved");
	});

	test("option fields keep None and Some distinct", () => {
		const none = decode(
			T.AlertDelivery,
			encode(T.AlertDelivery, { ...alertDelivery, lastError: undefined }),
		);
		expect(none.lastError).toBeUndefined();
		expect(
			decode(T.AlertDelivery, encode(T.AlertDelivery, alertDelivery)).lastError,
		).toBe("timeout");
	});

	test("a schedule-at timer row round-trips with its purpose", () => {
		const timer = {
			scheduledId: 1n,
			scheduledAt: ScheduleAt.time(t1.microsSinceUnixEpoch),
			needId: 7n,
			step: 2,
			purpose: { tag: "FollowUpDue" },
		};
		expect(decode(T.LadderTimer, encode(T.LadderTimer, timer))).toMatchObject(
			timer,
		);
	});
});

describe("generated reducers", () => {
	test("set_contact_ladder args round-trip with nested steps and backup", () => {
		const args = {
			familyId: 1n,
			contacts: [step],
			backup: undefined,
			answerSeconds: 60,
			followUpSeconds: 300,
		};
		const { params } = reducers.setContactLadder;
		const row = t.row(params);
		expect(decode(row, encode(row, args))).toMatchObject(args);
	});
});

describe("DbConnection", () => {
	test("builder() builds the typed connection with the generated subscription builder", () => {
		const conn = DbConnection.builder()
			.withUri("ws://127.0.0.1:1")
			.withDatabaseName("health")
			// No socket: the connection must never reach a server in this test.
			.withWSFn(() => Promise.reject(new Error("offline")))
			.build();
		try {
			expect(conn).toBeInstanceOf(DbConnection);
			expect(conn.subscriptionBuilder()).toBeInstanceOf(SubscriptionBuilder);
		} finally {
			conn.disconnect();
		}
	});
});
