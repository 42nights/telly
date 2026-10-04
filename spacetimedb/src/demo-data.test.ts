import { describe, expect, test } from "bun:test";
import type { Timestamp } from "spacetimedb";
import {
	at,
	type Harness,
	harness,
	identity,
	MODULE,
	mod,
} from "./test/harness.test";

const ray = identity(1);
const ana = identity(2);
const mallory = identity(3);
const kim = identity(4);

const NOW = "2026-10-04T14:00:00Z";
const micros = (t: { microsSinceUnixEpoch: bigint }) => t.microsSinceUnixEpoch;

type Sample = {
	id: bigint;
	familyId: bigint;
	metric: string;
	value: number;
	sourceTime: Timestamp;
	source: string;
};

// Families 1 and 2 (Ray's) have no recording; family 3 (Ana's) holds a WHOOP recording, a
// heart-rate rule above 160 bpm, and two rows that are not a recording.
const setup = () => {
	const h = harness(NOW);
	h.call(mod.createFamily, ray, { name: "Rivera" });
	h.call(mod.createFamily, ray, { name: "Empty" });
	h.call(mod.createFamily, ana, { name: "Telly's Family" });
	const record = (over: Record<string, unknown>) =>
		h.call(mod.recordSample, ana, {
			familyId: 3n,
			metric: "heart_rate",
			value: 60,
			unit: "bpm",
			sourceTime: at("2026-10-04T08:15:00Z"),
			source: "noop:my-whoop",
			synthetic: false,
			quality: { tag: "Unvalidated" },
			...over,
		});
	record({ value: 61 });
	record({ value: 58, sourceTime: at("2026-10-04T08:16:00Z") });
	record({ value: 55, sourceTime: at("2026-10-04T08:17:00Z") });
	record({
		metric: "resting_heart_rate",
		value: 52,
		sourceTime: at("2026-10-04T00:00:00Z"),
		source: "noop:my-whoop-noop",
	});
	record({ source: "watch", value: 70 });
	record({ synthetic: true, value: 99 });
	h.call(mod.setAlertThreshold, ana, {
		familyId: 3n,
		metric: "heart_rate",
		direction: { tag: "Above" },
		limit: 160,
		unit: "bpm",
		maxAgeSeconds: 300,
	});
	return h;
};

const samples = (h: Harness, familyId: bigint) =>
	h.rows<Sample>("healthSample").filter((s) => s.familyId === familyId);
const demo = (h: Harness, familyId: bigint) =>
	samples(h, familyId).filter((s) => s.source === "noop:demo");

// Runs the family's demo timer once, `seconds` after the last run.
const tick = (h: Harness, seconds = 15) => {
	h.advance(seconds);
	for (const timer of h.rows("demoTimer"))
		h.call(mod.runDemoTimer, MODULE, { timer } as never);
};

describe("setDemoData on", () => {
	test("copies the family's recording, moved so its newest sample is now", () => {
		const h = setup();
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		const copies = demo(h, 3n);
		expect(copies.map((s) => [s.metric, s.value])).toEqual([
			["heart_rate", 61],
			["heart_rate", 58],
			["heart_rate", 55],
			["resting_heart_rate", 52],
		]);
		const shift = micros(at(NOW)) - micros(at("2026-10-04T08:17:00Z"));
		expect(copies.map((s) => micros(s.sourceTime))).toEqual(
			[
				"2026-10-04T08:15:00Z",
				"2026-10-04T08:16:00Z",
				"2026-10-04T08:17:00Z",
				"2026-10-04T00:00:00Z",
			].map((iso) => micros(at(iso)) + shift),
		);
		// Members read the copies in place of the recording; other sources stay.
		expect(
			h
				.view(mod.myHealthSamples, ana)
				.map((s) => `${s.source} ${s.value}`)
				.sort(),
		).toEqual(
			[
				"noop:demo 52",
				"noop:demo 55",
				"noop:demo 58",
				"noop:demo 61",
				"noop:my-whoop 99",
				"watch 70",
			].sort(),
		);
		// A second "on" copies nothing again.
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		expect(demo(h, 3n)).toHaveLength(4);
	});

	test("a family with no recording replays family 3's", () => {
		const h = setup();
		h.call(mod.setDemoData, ray, { familyId: 1n, on: true });
		expect(demo(h, 1n).map((s) => s.value)).toEqual([61, 58, 55, 52]);
		tick(h);
		expect(demo(h, 1n).at(-1)).toMatchObject({ value: 61 });
	});

	test("fails when there is no recording to replay", () => {
		const h = harness(NOW);
		h.call(mod.createFamily, ray, { name: "Rivera" });
		expect(() =>
			h.call(mod.setDemoData, ray, { familyId: 1n, on: true }),
		).toThrow("there is no WHOOP recording to replay");
		expect(h.rows("demoReplay")).toEqual([]);
	});
});

describe("runDemoTimer", () => {
	test("records the recording's next heart rate, now, every 15 s, and loops", () => {
		const h = setup();
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		expect(h.rows("demoTimer")).toMatchObject([
			{
				familyId: 3n,
				scheduledAt: { value: { __time_duration_micros__: 15_000_000n } },
			},
		]);
		const live: [number, bigint][] = [];
		for (let i = 0; i < 4; i++) {
			tick(h);
			const newest = demo(h, 3n).at(-1) as Sample;
			live.push([newest.value, micros(newest.sourceTime)]);
		}
		const start = micros(at(NOW));
		expect(live).toEqual([
			[61, start + 15_000_000n],
			[58, start + 30_000_000n],
			[55, start + 45_000_000n],
			[61, start + 60_000_000n],
		]);
	});

	test("only the database runs it", () => {
		const h = setup();
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		const [timer] = h.rows("demoTimer");
		expect(() => h.call(mod.runDemoTimer, ana, { timer } as never)).toThrow(
			"only the database runs demo timers",
		);
	});
});

describe("setDemoData off", () => {
	test("stops the replay and deletes only the demo rows", () => {
		const h = setup();
		const real = samples(h, 3n);
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		h.call(mod.setDemoData, ray, { familyId: 1n, on: true });
		const [timer] = h.rows("demoTimer");
		tick(h);
		h.call(mod.setDemoData, ana, { familyId: 3n, on: false });
		expect(samples(h, 3n)).toEqual(real);
		expect(h.rows("demoReplay")).toMatchObject([{ familyId: 1n }]);
		expect(h.rows("demoTimer")).toMatchObject([{ familyId: 1n }]);
		// Family 1's replay goes on.
		expect(demo(h, 1n)).toHaveLength(5);
		// A run already due when it stopped records nothing.
		h.call(mod.runDemoTimer, MODULE, { timer } as never);
		expect(samples(h, 3n)).toEqual(real);
		expect(h.view(mod.myHealthSamples, ana)).toHaveLength(real.length);
	});
});

describe("showDemoAlert", () => {
	test("one spike above the threshold raises one alert, at most once a minute", () => {
		const h = setup();
		h.call(mod.setDemoData, ana, { familyId: 3n, on: true });
		tick(h);
		expect(h.rows("alert")).toEqual([]);
		h.call(mod.showDemoAlert, ana, { familyId: 3n });
		expect(h.rows("alert")).toMatchObject([
			{ familyId: 3n, summary: expect.stringContaining("heart_rate 175 bpm") },
		]);
		expect(h.rows("alertDelivery")).toMatchObject([
			{ familyId: 3n, status: { tag: "Queued" } },
		]);
		h.advance(30);
		expect(() => h.call(mod.showDemoAlert, ana, { familyId: 3n })).toThrow(
			"one demo alert a minute",
		);
		tick(h);
		expect(h.rows("alert")).toHaveLength(1);
		h.advance(31);
		h.call(mod.showDemoAlert, ana, { familyId: 3n });
		expect(h.rows("alert")).toHaveLength(2);
	});

	test("needs demo data on and a heart-rate rule", () => {
		const h = setup();
		expect(() => h.call(mod.showDemoAlert, ana, { familyId: 3n })).toThrow(
			"demo data is off",
		);
		h.call(mod.setDemoData, ray, { familyId: 1n, on: true });
		expect(() => h.call(mod.showDemoAlert, ray, { familyId: 1n })).toThrow(
			"set a heart rate threshold",
		);
		expect(h.rows("alert")).toEqual([]);
	});
});

describe("access", () => {
	test("any member may use demo data; a non-member may not", () => {
		const h = setup();
		// Kim is a member with no care grants.
		h.call(mod.addFamilyMember, ana, { familyId: 3n, member: kim });
		h.call(mod.setDemoData, kim, { familyId: 3n, on: true });
		h.call(mod.showDemoAlert, kim, { familyId: 3n });
		for (const call of [
			() => h.call(mod.setDemoData, mallory, { familyId: 3n, on: false }),
			() => h.call(mod.showDemoAlert, mallory, { familyId: 3n }),
		])
			expect(call).toThrow("not a member of this family");
		expect(demo(h, 3n)).toHaveLength(5);
	});
});
