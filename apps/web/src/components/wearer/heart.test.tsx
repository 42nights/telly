import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { FamilyRecords, HealthSample } from "@health/contracts";
import { installDom, render } from "../test/dom";

import { HeartReading } from "./heart";

installDom();

const now = Date.parse("2026-01-01T08:00:00Z");
const sample = (over: Partial<HealthSample>): HealthSample => ({
	id: "s1",
	familyId: "1",
	metric: "heart_rate",
	value: 72.4,
	unit: "bpm",
	sourceTime: new Date(now - 120_000).toISOString(),
	receivedAt: new Date(now).toISOString(),
	source: "apple_watch",
	synthetic: false,
	quality: "validated",
	...over,
});
const ready = (samples: HealthSample[]) =>
	({
		kind: "ready",
		at: now,
		value: {
			families: [],
			samples,
			alerts: [],
			messages: [],
			acknowledgements: [],
		},
	}) satisfies { kind: "ready"; at: number; value: FamilyRecords };

describe("HeartReading", () => {
	test("shows the newest validated reading, its place on the bar, its age, and its source", () => {
		const view = render(
			<HeartReading
				familyId="1"
				now={now}
				records={ready([
					sample({}),
					sample({ id: "old", value: 50, sourceTime: "2026-01-01T07:55:00Z" }),
				])}
			/>,
		);
		const bar = view.getByRole("img");
		expect(bar.getAttribute("aria-label")).toBe(
			"72 beats per minute. The band shows the usual range, 60 to 100.",
		);
		expect(view.container.textContent).toContain("72 bpm");
		expect(view.getByText("2 min ago · apple_watch")).toBeDefined();
		const [band, mark] = bar.children;
		expect(band?.getAttribute("style")).toContain("left: 20%");
		expect(mark?.getAttribute("style")).toContain("left: 28.2");
	});

	test("without a validated reading, a fresh watch reading shows and says it is unvalidated", () => {
		const view = render(
			<HeartReading
				familyId="1"
				now={now}
				records={ready([
					sample({ source: "noop:whoop", quality: "unvalidated", value: 90 }),
				])}
			/>,
		);
		expect(view.getByRole("img").getAttribute("aria-label")).toStartWith(
			"90 beats per minute.",
		);
		expect(view.container.textContent).toContain(
			"2 min ago · noop:whoop · unvalidated",
		);
	});

	test("an old or another family's reading is not shown as current", () => {
		const view = render(
			<HeartReading
				familyId="1"
				now={now}
				records={ready([
					sample({ sourceTime: "2026-01-01T07:00:00Z" }),
					sample({ id: "other", familyId: "2" }),
				])}
			/>,
		);
		expect(view.getByRole("img", { name: "No reading" })).toBeDefined();
		expect(view.container.textContent).toContain("Unavailable");
		expect(view.container.textContent).toContain("no recent reading");
	});

	test("without a selected family, ready records show no reading", () => {
		const view = render(
			<HeartReading familyId={null} now={now} records={ready([sample({})])} />,
		);
		expect(view.getByRole("img", { name: "No reading" })).toBeDefined();
	});

	test("with no person paired, it says so", () => {
		const view = render(
			<HeartReading familyId={null} now={now} records={null} />,
		);
		expect(view.container.textContent).toContain("Unavailable");
		expect(view.container.textContent).toContain("no person paired");
	});

	test("while loading, it is checking and waits for the server", () => {
		const view = render(
			<HeartReading familyId="1" now={now} records={{ kind: "loading" }} />,
		);
		expect(view.container.textContent).toContain("Checking…");
		expect(view.container.textContent).toContain("waiting for the server");
	});

	test.each([
		[{ kind: "signed_out" } as const, "sign in to see readings"],
		[{ kind: "forbidden", message: "x" } as const, "not shared with you"],
		[{ kind: "unavailable", message: "x" } as const, "can't read right now"],
		[{ kind: "error", message: "x" } as const, "can't read right now"],
	])("a failure says why there is no reading", (records, line) => {
		const view = render(
			<HeartReading familyId="1" now={now} records={records} />,
		);
		expect(view.container.textContent).toContain("Unavailable");
		expect(view.container.textContent).toContain(line);
	});
});
