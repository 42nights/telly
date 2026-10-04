// fallow-ignore-file unused-file -- `bun test` runs this file; fallow's bun plugin skips this package.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AlertThresholdInput } from "../src/alerts";
import { FamilyQuestion, QuestionAttachment } from "../src/ask";
import { TimeZone } from "../src/care-profile";
import { ExerciseEventInput, ExercisePlanInput } from "../src/exercise";
import { MealEstimateRequest, MealItem } from "../src/meal-facts";
import { ReportFields } from "../src/reports";
import { SignInCode } from "../src/session";
import { TripAnswer } from "../src/trips";

const decode = (schema: Schema.Top, input: unknown) =>
	Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>)(input);

describe("time zones", () => {
	test("TimeZone accepts IANA names and explains a refusal", () => {
		expect(decode(TimeZone, "Europe/London")).toBe("Europe/London");
		expect(() => decode(TimeZone, "Mars/Base")).toThrow(
			"must be an IANA time zone",
		);
	});

	test("FamilyQuestion checks its optional time zone", () => {
		expect(
			decode(FamilyQuestion, { question: "Hi?", timeZone: "Europe/Berlin" }),
		).toEqual({ question: "Hi?", timeZone: "Europe/Berlin" });
		expect(() =>
			decode(FamilyQuestion, { question: "Hi?", timeZone: "Nowhere" }),
		).toThrow('["timeZone"]');
	});
});

describe("base64 attachments", () => {
	const attachment = (data: string) => ({
		name: "a.txt",
		mimeType: "text/plain",
		data,
	});
	test.each(["aGk=", "aGVsbG8h"])("accepts %p", (data) => {
		expect(decode(QuestionAttachment, attachment(data))).toEqual(
			attachment(data),
		);
	});
	test.each(["aGk", "a$k=", ""])("rejects %p", (data) => {
		expect(() => decode(QuestionAttachment, attachment(data))).toThrow(
			'["data"]',
		);
	});

	const photo = (data: string) => ({
		source: "photo",
		capturedAt: "2026-01-01T08:00:00Z",
		image: { type: "image/png", data },
	});
	test("a meal photo must be base64", () => {
		expect(decode(MealEstimateRequest, photo("aGk="))).toEqual(photo("aGk="));
		expect(() => decode(MealEstimateRequest, photo("aGk"))).toThrow(
			'["image"]["data"]',
		);
	});
});

describe("exercise", () => {
	const plan = (demands: string[], restrictions: string[]) => ({
		activity: "Chair stands",
		steps: ["Stand up", "Sit down"],
		demands,
		restrictions,
		source: "Physio handout",
		windowStart: "09:00",
		windowEnd: "11:00",
		videoUrl: null,
	});
	test("a plan may not ask for a restricted demand", () => {
		expect(decode(ExercisePlanInput, plan(["standing"], ["floor"]))).toEqual(
			plan(["standing"], ["floor"]),
		);
		expect(() =>
			decode(ExercisePlanInput, plan(["standing", "floor"], ["floor"])),
		).toThrow(
			"The activity asks for a demand that a recorded restriction forbids",
		);
	});

	const event = (kind: string, reason: string | null) => ({
		id: "e1",
		planId: "1",
		sessionId: "s1",
		kind,
		reason,
	});
	test.each([
		["stopped", "pain"],
		["completed", null],
	])("%s with reason %p is accepted", (kind, reason) => {
		expect(decode(ExerciseEventInput, event(kind, reason))).toEqual(
			event(kind, reason),
		);
	});
	test.each([
		["stopped", null],
		["paused", "pain"],
	])("%s with reason %p is refused", (kind, reason) => {
		expect(() => decode(ExerciseEventInput, event(kind, reason))).toThrow(
			"Only a stopped event has a reason",
		);
	});
});

describe("meal estimate ranges", () => {
	const item = (low: number, high: number) => ({
		name: "rice",
		preparation: null,
		portion: "1 cup",
		energyKcal: { low, high },
		proteinG: { low: 0, high: 0 },
		carbohydrateG: { low: 0, high: 0 },
		fatG: { low: 0, high: 0 },
	});
	test("low may equal high but not exceed it", () => {
		expect(decode(MealItem, item(5, 5))).toEqual(item(5, 5));
		expect(() => decode(MealItem, item(6, 5))).toThrow(
			"low must not be greater than high",
		);
		expect(() => decode(MealItem, item(-1, 5))).toThrow(
			'["energyKcal"]["low"]',
		);
	});
});

describe("report fields", () => {
	const base = {
		patientName: null,
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: null,
	};
	const correction = (metric: string) => ({
		metric,
		value: 1,
		reason: "typo",
	});
	test("keys added later decode as not filled in", () => {
		expect(decode(ReportFields, base)).toEqual({
			...base,
			observations: null,
			questions: null,
			corrections: [],
		});
	});
	test("at most one correction per marker", () => {
		expect(() =>
			decode(ReportFields, {
				...base,
				corrections: [correction("hr"), correction("hr")],
			}),
		).toThrow("at most one correction per marker");
	});
});

describe("alert thresholds", () => {
	const input = (maxAgeSeconds: number) => ({
		metric: "heart_rate",
		direction: "above",
		limit: 120,
		unit: "bpm",
		maxAgeSeconds,
	});
	test.each([1, 604_800])("maxAgeSeconds %p is accepted", (s) => {
		expect(decode(AlertThresholdInput, input(s))).toEqual(input(s));
	});
	test.each([0, 604_801, 1.5])("maxAgeSeconds %p is refused", (s) => {
		expect(() => decode(AlertThresholdInput, input(s))).toThrow(
			'["maxAgeSeconds"]',
		);
	});
});

describe("trip answers", () => {
	const leaving = (battery: number | null, purpose = "shopping") => ({
		answer: "leaving",
		purpose,
		destination: null,
		notify: { departure: true, arrival: false },
		battery,
	});
	test.each([0, 1, null])("battery %p is accepted", (b) => {
		expect(decode(TripAnswer, leaving(b))).toEqual(leaving(b));
	});
	test.each([
		[leaving(1.01), "battery"],
		[leaving(0.5, "  "), "purpose"],
		[leaving(0.5, "x".repeat(201)), "purpose"],
		[{ answer: "maybe" }, "answer"],
	])("%p is refused at %s", (answer, key) => {
		expect(() => decode(TripAnswer, answer)).toThrow(`["${key}"]`);
	});
	test("cancel needs no plan", () => {
		expect(decode(TripAnswer, { answer: "cancel" })).toEqual({
			answer: "cancel",
		});
	});
});

describe("sign-in code", () => {
	test.each([
		["v".repeat(43), true],
		["v".repeat(128), true],
		["v".repeat(42), false],
		["v".repeat(129), false],
		[`${"v".repeat(42)}+`, false],
	])("verifier %#", (codeVerifier, ok) => {
		const run = () =>
			decode(SignInCode, { code: "c", codeVerifier, redirectUri: "r" });
		if (ok)
			expect(run()).toEqual({ code: "c", codeVerifier, redirectUri: "r" });
		else expect(run).toThrow('["codeVerifier"]');
	});
});
