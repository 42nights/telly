import { expect, test } from "bun:test";
import type { HealthSample } from "@health/contracts";

import {
	dailyAge,
	inviteCode,
	liveAge,
	newestHeartRate,
	noopLink,
	onboardingTarget,
	reminderRules,
	whoopSamples,
} from "./logic";

const now = Date.parse("2026-10-04T12:00:00Z");
const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

test("a heart rate is current for 10 minutes, then says it is not current", () => {
	expect(liveAge(minutesAgo(0.5), now)).toEqual({
		text: "just now",
		tone: "current",
	});
	expect(liveAge(minutesAgo(4), now)).toEqual({
		text: "4 min ago",
		tone: "current",
	});
	expect(liveAge(minutesAgo(10), now).tone).toBe("current");
	expect(liveAge(minutesAgo(11), now)).toEqual({
		text: "11 min ago · not current",
		tone: "old",
	});
	expect(liveAge(minutesAgo(150), now)).toEqual({
		text: "2 h ago · not current",
		tone: "old",
	});
});

test("a daily value says last night, today with its time, or its date", () => {
	const local = (day: number, hour: number, minute = 0) =>
		new Date(2026, 9, day, hour, minute).toISOString();
	const noon = new Date(2026, 9, 4, 12).getTime();
	expect(dailyAge(local(3, 23), noon).text).toBe("last night");
	expect(dailyAge(local(4, 5, 59), noon).text).toBe("last night");
	expect(dailyAge(local(4, 7, 5), noon).text).toBe("today 07:05");
	expect(dailyAge(local(3, 9), noon).text).toBe(
		new Date(2026, 9, 3, 9).toLocaleDateString([], {
			month: "short",
			day: "numeric",
		}),
	);
});

test("a signed-in person without a family goes to onboarding, except to join by invite", () => {
	expect(onboardingTarget("/hud", true)).toBe("/welcome");
	expect(onboardingTarget("/welcome", true)).toBeNull();
	expect(onboardingTarget("/sign-in", true)).toBeNull();
	expect(onboardingTarget("/join/abc", true)).toBeNull();
	expect(onboardingTarget("/hud", false)).toBeNull();
});

test("an invite code comes from a pasted link or a bare code", () => {
	expect(inviteCode("https://app.example/join/Ab-12_x")).toBe("Ab-12_x");
	expect(inviteCode("  Ab-12_x ")).toBe("Ab-12_x");
	expect(inviteCode("")).toBeNull();
	expect(inviteCode("two words")).toBeNull();
});

test("the NOOP link carries the push URL with the token in its query", () => {
	const link = noopLink("https://api.example", "t/k+1");
	expect(link.startsWith("noop://telly-push?url=")).toBe(true);
	expect(new URL(link).searchParams.get("url")).toBe(
		"https://api.example/api/noop/ingest?k=t%2Fk%2B1",
	);
});

const sample = (
	id: string,
	source: string,
	sourceTime: string,
	synthetic = false,
): HealthSample => ({
	id,
	familyId: "1",
	metric: "heart_rate",
	value: 60,
	unit: "bpm",
	sourceTime,
	receivedAt: sourceTime,
	source,
	synthetic,
	quality: "unvalidated",
});

test("WHOOP status reads only real NOOP samples, newest by source time", () => {
	const samples = whoopSamples([
		sample("phone", "healthkit:watch", minutesAgo(1)),
		sample("fake", "noop:dev", minutesAgo(1), true),
		sample("old", "noop:dev", minutesAgo(30)),
		sample("new", "noop:dev", minutesAgo(5)),
	]);
	expect(samples.map((s) => s.id)).toEqual(["old", "new"]);
	expect(newestHeartRate(samples)?.id).toBe("new");
	expect(newestHeartRate([])).toBeNull();
});

test("reminder rules need a zone and three whole numbers", () => {
	const typed = { repeat: " 10 ", max: "3", snooze: "15" };
	expect(reminderRules("Europe/London", typed)).toEqual({
		timeZone: "Europe/London",
		quietHours: null,
		repeatEveryMinutes: 10,
		maxPrompts: 3,
		snoozeMinutes: 15,
	});
	expect(reminderRules("", typed)).toBeNull();
	expect(reminderRules("Europe/London", { ...typed, max: "" })).toBeNull();
	expect(
		reminderRules("Europe/London", { ...typed, snooze: "1.5" }),
	).toBeNull();
});
