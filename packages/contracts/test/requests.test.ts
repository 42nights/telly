// fallow-ignore-file unused-file -- `bun test` runs this file; fallow's bun plugin skips this package.
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AppointmentRequest } from "../src/appointments";
import { NewCareNeed } from "../src/care";
import { CookingProfile } from "../src/cooking";
import { CueRequest } from "../src/cues";
import { NewDeliveryProposal } from "../src/delivery";
import { EmergencyRequest } from "../src/emergency";
import { HealthKitImport } from "../src/healthkit";
import { RememberMedicine } from "../src/medicine-memory";
import { SpeakerSettings } from "../src/speaker";
import { ToolRequest } from "../src/tools";
import { TrendQuestion } from "../src/trends";

const T = "2026-01-01T08:00:00Z";

const need = {
	clientId: "n-1",
	kind: "help",
	summary: "Needs a lift",
	sampleIds: ["1"],
	dueAt: null,
};
const cooking = {
	tasks: {
		stove: "with_helper",
		oven: "not_allowed",
		microwave: "alone",
		toaster: "alone",
		knife: "not_allowed",
	},
	dislikes: ["okra"],
};
const delivery = {
	requirements: {
		address: "1 Main St",
		recipient: "Wearer, at home",
		allergies: [],
		dietaryNeeds: ["vegetarian"],
		assistance: [],
		window: { start: T, end: T },
		budgetCents: 3000,
	},
	items: [{ menuItemId: "soup-1", quantity: 2 }],
	tipCents: 300,
};
const help = {
	kind: "help",
	report: "I fell",
	wearer: { name: "Ana", callback: "+1 555 0100" },
	location: {
		status: "fix",
		latitude: 40,
		longitude: -73,
		accuracyMeters: 5,
		capturedAt: T,
	},
};
const sample = {
	uuid: "0A1B2C3D-0000-4000-8000-00000000ABCD",
	type: "HKQuantityTypeIdentifierHeartRate",
	value: 72,
	unit: "count/min",
	startDate: T,
	endDate: T,
	sourceBundleId: "com.apple.health",
	sourceName: "Watch",
	deviceModel: null,
	deviceManufacturer: null,
	externalUuid: null,
};
const sighting = {
	container: "Lisinopril bottle",
	place: "kitchen counter",
	seenAt: T,
	source: "camera_check",
	confidence: 0.9,
	labelRead: true,
};

// [schema, valid payload, payload that breaks one real constraint, issue path of that constraint]
test.each([
	[
		"appointments",
		AppointmentRequest,
		{ confirm: true },
		{ confirm: false },
		'["confirm"]',
	],
	["care", NewCareNeed, need, { ...need, kind: "alert" }, '["kind"]'],
	["care", NewCareNeed, need, { ...need, clientId: "bad id" }, '["clientId"]'],
	[
		"cooking",
		CookingProfile,
		cooking,
		{ ...cooking, tasks: { ...cooking.tasks, knife: "sometimes" } },
		'["tasks"]["knife"]',
	],
	[
		"cooking",
		CookingProfile,
		cooking,
		{ ...cooking, dislikes: [" okra"] },
		'["dislikes"][0]',
	],
	[
		"cues",
		CueRequest,
		{ sampleIds: ["1", "2"] },
		{ sampleIds: [] },
		'["sampleIds"]',
	],
	[
		"cues",
		CueRequest,
		{ sampleIds: ["1"] },
		{ sampleIds: ["1", "1"] },
		'["sampleIds"]',
	],
	[
		"cues",
		CueRequest,
		{ sampleIds: ["1"] },
		{ sampleIds: Array.from({ length: 33 }, (_, i) => `${i}`) },
		'["sampleIds"]',
	],
	[
		"delivery",
		NewDeliveryProposal,
		delivery,
		{ ...delivery, items: [{ menuItemId: "soup-1", quantity: 11 }] },
		'["items"][0]["quantity"]',
	],
	[
		"delivery",
		NewDeliveryProposal,
		delivery,
		{ ...delivery, tipCents: 100_001 },
		'["tipCents"]',
	],
	[
		"delivery",
		NewDeliveryProposal,
		delivery,
		{ ...delivery, requirements: { ...delivery.requirements, address: "" } },
		'["requirements"]["address"]',
	],
	[
		"emergency",
		EmergencyRequest,
		help,
		{ ...help, location: { ...help.location, latitude: 91 } },
		'["location"]["latitude"]',
	],
	[
		"emergency",
		EmergencyRequest,
		help,
		{ ...help, wearer: { name: null, callback: "call me" } },
		'["wearer"]["callback"]',
	],
	[
		"emergency",
		EmergencyRequest,
		{ kind: "event", event: { kind: "ouch", report: "ouch", observedAt: T } },
		{ kind: "event", event: { kind: "ouch", report: " ", observedAt: T } },
		'["event"]["report"]',
	],
	[
		"healthkit",
		HealthKitImport,
		{ access: "requested", synthetic: false, samples: [sample] },
		{
			access: "requested",
			synthetic: false,
			samples: [{ ...sample, uuid: "0a1b2c3d-0000-4000-8000-00000000abcd" }],
		},
		'["samples"][0]["uuid"]',
	],
	[
		"healthkit",
		HealthKitImport,
		{ access: "denied", synthetic: false, samples: [] },
		{ access: "granted", synthetic: false, samples: [] },
		'["access"]',
	],
	[
		"medicine-memory",
		RememberMedicine,
		sighting,
		{ ...sighting, confidence: 1.1 },
		'["confidence"]',
	],
	[
		"medicine-memory",
		RememberMedicine,
		sighting,
		{ ...sighting, place: "x".repeat(121) },
		'["place"]',
	],
	[
		"speaker",
		SpeakerSettings,
		{ enabled: true, room: "private", sharedRoomKinds: [] },
		{ enabled: true, room: "hall", sharedRoomKinds: [] },
		'["room"]',
	],
	[
		"tools",
		ToolRequest,
		{ tool: "health_samples", input: { metric: "heart_rate", limit: 100 } },
		{ tool: "health_samples", input: { limit: 101 } },
		'["input"]["limit"]',
	],
	[
		"tools",
		ToolRequest,
		{ tool: "alerts", input: {} },
		{ tool: "alerts", input: { limit: 0 } },
		'["input"]["limit"]',
	],
	[
		"tools",
		ToolRequest,
		{ tool: "saved_things", input: { limit: 5 } },
		{ tool: "saved_things", input: { limit: 0 } },
		'["input"]["limit"]',
	],
	[
		"trends",
		TrendQuestion,
		{ question: "Why is my HRV low?", days: 90 },
		{ question: "Why?", days: 91 },
		'["days"]',
	],
	[
		"trends",
		TrendQuestion,
		{ question: "Why?" },
		{ question: "\n" },
		'["question"]',
	],
] as const)(
	"%s: valid decodes, broken is refused",
	(_, schema, valid, broken, path) => {
		const decode = Schema.decodeUnknownSync(
			schema as unknown as Schema.Decoder<unknown>,
		);
		expect(decode(valid)).toEqual(valid);
		expect(() => decode(broken)).toThrow(path);
	},
);

test("tools reject an unknown tool", () => {
	expect(() =>
		Schema.decodeUnknownSync(ToolRequest)({ tool: "shell", input: {} }),
	).toThrow('"tool": "health_samples"');
});
