import { describe, expect, test } from "bun:test";
import { at, harness, identity, MODULE, mod } from "./test/harness.test";

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);
const op = identity(9);

const NOW = "2026-01-05T12:00:00Z";

const withFamily = () => {
	const h = harness(NOW);
	h.call(mod.createFamily, alice, { name: "Rivera" });
	return h;
};

const sample = (over: Record<string, unknown> = {}) => ({
	familyId: 1n,
	metric: "heart_rate",
	value: 130,
	unit: "bpm",
	sourceTime: at("2026-01-05T11:59:00Z"),
	source: "watch",
	synthetic: false,
	quality: { tag: "Validated" },
	...over,
});

const rule = (over: Record<string, unknown> = {}) => ({
	familyId: 1n,
	metric: "heart_rate",
	direction: { tag: "Above" },
	limit: 120,
	unit: "bpm",
	maxAgeSeconds: 300,
	...over,
});

// A family with an Above 120 bpm rule (and a Below 40 bpm rule).
const withRules = () => {
	const h = withFamily();
	h.call(mod.setAlertThreshold, alice, rule());
	h.call(
		mod.setAlertThreshold,
		alice,
		rule({ direction: { tag: "Below" }, limit: 40 }),
	);
	return h;
};

// A family with one alert and an operator.
const withAlert = () => {
	const h = withFamily();
	h.call(mod.init, op, {});
	h.call(mod.raiseAlert, alice, {
		familyId: 1n,
		sampleId: undefined,
		summary: "fell",
	});
	return h;
};

describe("createFamily", () => {
	test("makes the caller the first member", () => {
		const h = withFamily();
		expect(h.rows("family")).toMatchObject([{ id: 1n, name: "Rivera" }]);
		expect(h.view(mod.myFamilies, alice)).toMatchObject([{ name: "Rivera" }]);
		expect(h.view(mod.myFamilies, bob)).toEqual([]);
	});

	test("rejects a blank name and stores nothing", () => {
		const h = harness();
		expect(() => h.call(mod.createFamily, alice, { name: "  " })).toThrow(
			"name must not be empty",
		);
		expect(h.rows("family")).toEqual([]);
	});
});

describe("addFamilyMember", () => {
	test("a member adds someone once; an outsider cannot", () => {
		const h = withFamily();
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
		expect(h.rows("familyMember")).toHaveLength(2);
		expect(h.view(mod.myFamilies, bob)).toMatchObject([{ name: "Rivera" }]);
		expect(() =>
			h.call(mod.addFamilyMember, mallory, { familyId: 1n, member: mallory }),
		).toThrow("not a member of this family");
	});
});

describe("recordSample", () => {
	test("stores the sample, visible only to members", () => {
		const h = withFamily();
		h.call(mod.recordSample, alice, sample());
		expect(h.view(mod.myHealthSamples, alice)).toMatchObject([
			{ id: 1n, value: 130, recordedBy: alice },
		]);
		expect(h.view(mod.myHealthSamples, bob)).toEqual([]);
		expect(h.rows("alert")).toEqual([]);
	});

	test.each([
		[{ familyId: 2n }, "not a member of this family"],
		[{ metric: " " }, "metric must not be empty"],
		[{ unit: "" }, "unit must not be empty"],
		[{ source: "" }, "source must not be empty"],
		[{ value: Number.NaN }, "value must be a finite number"],
		[{ value: Number.POSITIVE_INFINITY }, "value must be a finite number"],
	])("rejects %#", (over, message) => {
		const h = withFamily();
		expect(() => h.call(mod.recordSample, alice, sample(over))).toThrow(
			message,
		);
		expect(h.rows("healthSample")).toEqual([]);
	});

	test.each([
		[
			"above, fresh",
			{},
			"heart_rate 130 bpm at 2026-01-05T11:59:00.000000Z is above 120 bpm",
		],
		[
			"below",
			{ value: 30 },
			"heart_rate 30 bpm at 2026-01-05T11:59:00.000000Z is below 40 bpm",
		],
		["exactly max age", { sourceTime: at("2026-01-05T11:55:00Z") }, "is above"],
		[
			"clock 60 s ahead",
			{ sourceTime: at("2026-01-05T12:01:00Z") },
			"is above",
		],
		["synthetic", { synthetic: true }, "Synthetic: heart_rate 130 bpm"],
	])("raises an alert: %s", (_, over, summary) => {
		const h = withRules();
		h.call(mod.recordSample, alice, sample(over));
		const alerts = h.rows("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ familyId: 1n, sampleId: 1n });
		expect(alerts[0]?.summary).toContain(summary);
		expect(h.rows("alertDelivery")).toMatchObject([
			{ alertId: 1n, status: { tag: "Queued" }, attempts: 0 },
		]);
		expect(h.rows("thresholdTrigger")).toHaveLength(1);
	});

	test.each([
		["within limits", { value: 120 }],
		["at the low limit", { value: 40 }],
		["stale", { sourceTime: at("2026-01-05T11:54:59Z") }],
		["clock too far ahead", { sourceTime: at("2026-01-05T12:01:01Z") }],
		["unit mismatch", { unit: "bps" }],
		["other metric", { metric: "spo2" }],
		["unvalidated", { quality: { tag: "Unvalidated" } }],
	])("raises nothing: %s", (_, over) => {
		const h = withRules();
		h.call(mod.recordSample, alice, sample(over));
		expect(h.rows("healthSample")).toHaveLength(1);
		expect(h.rows("alert")).toEqual([]);
		expect(h.rows("alertDelivery")).toEqual([]);
	});

	test("a resent reading alerts once; another source alerts again", () => {
		const h = withRules();
		h.call(mod.recordSample, alice, sample());
		h.call(mod.recordSample, alice, sample());
		expect(h.rows("healthSample")).toHaveLength(2);
		expect(h.rows("alert")).toHaveLength(1);
		h.call(mod.recordSample, alice, sample({ source: "ring" }));
		expect(h.rows("alert")).toHaveLength(2);
	});
});

describe("alert care needs", () => {
	test("a second alert while the need is open adds facts, not a new need", () => {
		const h = withRules();
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
		h.call(mod.setContactLadder, alice, {
			familyId: 1n,
			contacts: [
				{
					member: bob,
					name: "Bob",
					timeZone: "UTC",
					detail: { tag: "Facts" },
					callFor: [],
				},
			],
			backup: undefined,
			answerSeconds: 60,
			followUpSeconds: 600,
		});
		h.call(mod.recordSample, alice, sample());
		expect(h.rows("careNeed")).toMatchObject([
			{
				kind: { tag: "Alert" },
				status: { tag: "Open" },
				alertId: 1n,
				clientId: "alert-1",
			},
		]);
		expect(h.rows("careNeed")[0]?.facts).toHaveLength(1);
		h.call(mod.recordSample, alice, sample({ source: "ring", value: 131 }));
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: undefined,
			summary: "fell",
		});
		const needs = h.rows("careNeed");
		expect(needs).toHaveLength(1);
		expect(needs[0]?.facts).toHaveLength(2);
		expect(h.rows("alert")).toHaveLength(3);
	});

	test("without a ladder an alert opens no need", () => {
		const h = withAlert();
		expect(h.rows("careNeed")).toEqual([]);
	});
});

describe("raiseAlert", () => {
	test("links a sample of the same family and queues a delivery", () => {
		const h = withFamily();
		h.call(
			mod.recordSample,
			alice,
			sample({ quality: { tag: "Unvalidated" } }),
		);
		h.call(mod.raiseAlert, alice, {
			familyId: 1n,
			sampleId: 1n,
			summary: "dizzy",
		});
		expect(h.view(mod.myAlerts, alice)).toMatchObject([
			{ id: 1n, sampleId: 1n, summary: "dizzy", raisedBy: alice },
		]);
		expect(h.view(mod.myAlerts, bob)).toEqual([]);
		expect(h.view(mod.myAlertDeliveries, alice)).toMatchObject([
			{ alertId: 1n, status: { tag: "Queued" } },
		]);
		expect(h.view(mod.myAlertDeliveries, bob)).toEqual([]);
	});

	test.each([
		[1n, 1n, "sample does not belong to this family"],
		[1n, 99n, "sample does not belong to this family"],
		[3n, undefined, "not a member of this family"],
	])("family %p sample %p is rejected", (familyId, sampleId, message) => {
		const h = withFamily();
		h.call(mod.createFamily, bob, { name: "Other" });
		h.call(mod.recordSample, bob, sample({ familyId: 2n }));
		h.call(mod.recordSample, alice, sample());
		expect(() =>
			h.call(mod.raiseAlert, alice, { familyId, sampleId, summary: "x" }),
		).toThrow(message);
		expect(h.rows("alert")).toEqual([]);
	});

	test("rejects an empty summary", () => {
		const h = withFamily();
		expect(() =>
			h.call(mod.raiseAlert, alice, {
				familyId: 1n,
				sampleId: undefined,
				summary: " ",
			}),
		).toThrow("summary must not be empty");
	});
});

describe("sendMessage", () => {
	test("a resend with the same clientId stores one message", () => {
		const h = withFamily();
		h.call(mod.sendMessage, alice, {
			familyId: 1n,
			clientId: "c1",
			body: "hi",
		});
		h.call(mod.sendMessage, alice, {
			familyId: 1n,
			clientId: "c1",
			body: "hi",
		});
		expect(h.view(mod.myMessages, alice)).toMatchObject([
			{ id: 1n, body: "hi", sender: alice, clientId: "c1" },
		]);
		expect(h.view(mod.myMessages, bob)).toEqual([]);
		expect(() =>
			h.call(mod.sendMessage, alice, {
				familyId: 1n,
				clientId: "c1",
				body: "other",
			}),
		).toThrow("clientId is already used for another message");
	});

	test.each([
		["alert-1", "hi", "clientId must not start with alert-"],
		["", "hi", "clientId must not be empty"],
		["c1", " ", "body must not be empty"],
	])("rejects clientId %p body %p", (clientId, body, message) => {
		const h = withFamily();
		expect(() =>
			h.call(mod.sendMessage, alice, {
				familyId: 1n,
				clientId: clientId,
				body: body,
			}),
		).toThrow(message);
		expect(h.rows("message")).toEqual([]);
	});

	test("an outsider cannot post", () => {
		const h = withFamily();
		expect(() =>
			h.call(mod.sendMessage, bob, { familyId: 1n, clientId: "c", body: "x" }),
		).toThrow("not a member of this family");
	});
});

describe("acknowledgeAlert", () => {
	test("each member acknowledges once", () => {
		const h = withAlert();
		h.call(mod.addFamilyMember, alice, { familyId: 1n, member: bob });
		h.call(mod.acknowledgeAlert, alice, { alertId: 1n });
		h.call(mod.acknowledgeAlert, alice, { alertId: 1n });
		h.call(mod.acknowledgeAlert, bob, { alertId: 1n });
		expect(h.view(mod.myAcknowledgements, alice)).toMatchObject([
			{ alertId: 1n, familyId: 1n, member: alice },
			{ alertId: 1n, familyId: 1n, member: bob },
		]);
		expect(h.view(mod.myAcknowledgements, mallory)).toEqual([]);
	});

	test.each([1n, 99n])("an outsider cannot acknowledge alert %p", (alertId) => {
		const h = withAlert();
		expect(() => h.call(mod.acknowledgeAlert, mallory, { alertId })).toThrow(
			"not a member of this family",
		);
	});
});

describe("setAlertThreshold / removeAlertThreshold", () => {
	test("setting the same direction again replaces the rule", () => {
		const h = withRules();
		h.advance(10);
		h.call(mod.setAlertThreshold, alice, rule({ limit: 150 }));
		const rules = h.view(mod.myAlertThresholds, alice);
		expect(rules).toHaveLength(2);
		expect(rules.find((r) => r.id === 1n)).toMatchObject({
			limit: 150,
			direction: { tag: "Above" },
		});
		expect(h.view(mod.myAlertThresholds, bob)).toEqual([]);
		h.call(mod.recordSample, alice, sample());
		expect(h.rows("alert")).toEqual([]);
	});

	test.each([
		[{ familyId: 2n }, "not a member of this family"],
		[{ metric: "" }, "metric must not be empty"],
		[{ unit: " " }, "unit must not be empty"],
		[{ limit: Number.NaN }, "limit must be a finite number"],
		[{ maxAgeSeconds: 0 }, "maxAgeSeconds must be positive"],
	])("rejects %#", (over, message) => {
		const h = withFamily();
		expect(() => h.call(mod.setAlertThreshold, alice, rule(over))).toThrow(
			message,
		);
		expect(h.rows("alertThreshold")).toEqual([]);
	});

	test("a member removes a rule; others and unknown ids fail alike", () => {
		const h = withRules();
		expect(() =>
			h.call(mod.removeAlertThreshold, mallory, { thresholdId: 1n }),
		).toThrow("not a member of this family");
		expect(() =>
			h.call(mod.removeAlertThreshold, alice, { thresholdId: 99n }),
		).toThrow("not a member of this family");
		h.call(mod.removeAlertThreshold, alice, { thresholdId: 1n });
		expect(h.rows("alertThreshold")).toMatchObject([{ id: 2n }]);
	});
});

describe("alert delivery outbox", () => {
	test("init makes the caller the operator, who alone sees pending work", () => {
		const h = withAlert();
		expect(h.rows("operator")).toEqual([{ identity: op }]);
		expect(h.view(mod.pendingAlertDeliveries, op)).toMatchObject([
			{
				alertId: 1n,
				familyId: 1n,
				summary: "fell",
				status: { tag: "Queued" },
				attempts: 0,
			},
		]);
		expect(h.view(mod.pendingAlertDeliveries, alice)).toEqual([]);
	});

	test.each([
		["claimAlertDelivery", { alertId: 1n, leaseSeconds: 30 }],
		["markAlertDeliverySent", { alertId: 1n }],
		[
			"markAlertDeliveryFailed",
			{ alertId: 1n, error: "x", retryAfterSeconds: undefined },
		],
		["markAlertDeliveryUnavailable", { alertId: 1n, reason: "x" }],
		["postAlertMessage", { alertId: 1n }],
	] as const)(
		"%s rejects a non-operator and an unknown delivery",
		(name, args) => {
			const h = withAlert();
			const reducer = mod[name] as Parameters<typeof h.call>[0];
			expect(() => h.call(reducer, alice, args)).toThrow(
				"not the delivery operator",
			);
			expect(() => h.call(reducer, op, { ...args, alertId: 9n })).toThrow(
				"no such delivery",
			);
			expect(h.rows("alertDelivery")[0]).toMatchObject({
				status: { tag: "Queued" },
				attempts: 0,
			});
		},
	);

	test("a claim leases the delivery; it is due again when the lease ends", () => {
		const h = withAlert();
		h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 });
		expect(h.rows("alertDelivery")[0]).toMatchObject({
			attempts: 1,
			notBefore: at("2026-01-05T12:00:30Z"),
		});
		expect(() =>
			h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 }),
		).toThrow("delivery is not due");
		h.advance(30);
		h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 });
		expect(h.rows("alertDelivery")[0]).toMatchObject({ attempts: 2 });
	});

	test.each([0, 301])("rejects leaseSeconds %p", (leaseSeconds) => {
		const h = withAlert();
		expect(() =>
			h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds }),
		).toThrow("leaseSeconds must be 1 to 300");
		expect(h.rows("alertDelivery")[0]).toMatchObject({ attempts: 0 });
	});

	test("a retryable failure backs off; a final failure stops delivery", () => {
		const h = withAlert();
		h.call(mod.markAlertDeliveryFailed, op, {
			alertId: 1n,
			error: "timeout",
			retryAfterSeconds: 60,
		});
		expect(h.rows("alertDelivery")[0]).toMatchObject({
			status: { tag: "Queued" },
			lastError: "timeout",
			notBefore: at("2026-01-05T12:01:00Z"),
		});
		expect(() =>
			h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 }),
		).toThrow("delivery is not due");
		h.call(mod.markAlertDeliveryFailed, op, {
			alertId: 1n,
			error: "rejected",
			retryAfterSeconds: undefined,
		});
		expect(h.rows("alertDelivery")[0]).toMatchObject({
			status: { tag: "Failed" },
			lastError: "rejected",
		});
		expect(h.view(mod.pendingAlertDeliveries, op)).toEqual([]);
		h.advance(3600);
		expect(() =>
			h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 }),
		).toThrow("delivery is not due");
	});

	test("an unavailable delivery stays pending and can be claimed now", () => {
		const h = withAlert();
		h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 });
		h.call(mod.markAlertDeliveryUnavailable, op, {
			alertId: 1n,
			reason: "no push",
		});
		expect(h.view(mod.pendingAlertDeliveries, op)).toMatchObject([
			{ status: { tag: "Unavailable" }, notBefore: at(NOW) },
		]);
		h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 });
		expect(h.rows("alertDelivery")[0]).toMatchObject({
			status: { tag: "Queued" },
			attempts: 2,
		});
	});

	test("Sent is final: later reports change nothing", () => {
		const h = withAlert();
		h.call(mod.markAlertDeliveryFailed, op, {
			alertId: 1n,
			error: "timeout",
			retryAfterSeconds: 5,
		});
		h.call(mod.markAlertDeliverySent, op, { alertId: 1n });
		const sent = h.rows("alertDelivery")[0];
		expect(sent).toMatchObject({
			status: { tag: "Sent" },
			lastError: undefined,
		});
		h.advance(60);
		h.call(mod.markAlertDeliverySent, op, { alertId: 1n });
		h.call(mod.markAlertDeliveryFailed, op, {
			alertId: 1n,
			error: "late",
			retryAfterSeconds: undefined,
		});
		h.call(mod.markAlertDeliveryUnavailable, op, {
			alertId: 1n,
			reason: "late",
		});
		expect(h.rows("alertDelivery")[0]).toEqual(sent);
		expect(() =>
			h.call(mod.claimAlertDelivery, op, { alertId: 1n, leaseSeconds: 30 }),
		).toThrow("delivery is not due");
		expect(h.view(mod.pendingAlertDeliveries, op)).toEqual([]);
	});

	test("postAlertMessage posts the summary once to the family thread", () => {
		const h = withAlert();
		h.call(mod.postAlertMessage, op, { alertId: 1n });
		h.call(mod.postAlertMessage, op, { alertId: 1n });
		expect(h.view(mod.myMessages, alice)).toMatchObject([
			{ familyId: 1n, sender: op, body: "fell", clientId: "alert-1" },
		]);
	});
});

test("MODULE is not an operator unless init ran as it", () => {
	const h = withAlert();
	expect(h.view(mod.pendingAlertDeliveries, MODULE)).toEqual([]);
});
