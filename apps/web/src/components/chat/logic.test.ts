import { expect, test } from "bun:test";

import {
	type Ask,
	acceptFiles,
	evidenceLine,
	formatSize,
	mergeMessages,
	nextGeminiStatus,
	queueSend,
	timeline,
} from "./logic";

const msg = (id: string, body = id) => ({
	id,
	familyId: "1",
	sender: "s",
	body,
	sentAt: "2026-10-04T00:00:00.000Z",
	clientId: `c${id}`,
});

test("mergeMessages dedupes by id and orders numerically", () => {
	const merged = mergeMessages(
		[msg("9"), msg("10")],
		[msg("10", "dup"), msg("2"), msg("11")],
	);
	expect(merged.map((m) => m.id)).toEqual(["2", "9", "10", "11"]);
	expect(merged.filter((m) => m.id === "10")).toHaveLength(1);
});

test("queueSend reuses a failed message's clientId only for the same body", () => {
	let n = 0;
	const make = () => `id${++n}`;
	const first = queueSend([], "hi", make);
	expect(first.clientId).toBe("id1");
	const failed = first.outbox.map((e) => ({ ...e, status: "failed" as const }));
	const retry = queueSend(failed, "hi", make);
	expect(retry.clientId).toBe("id1");
	expect(retry.outbox).toEqual([
		{ clientId: "id1", body: "hi", status: "sending" },
	]);
	const other = queueSend(failed, "hello", make);
	expect(other.clientId).toBe("id2");
	expect(other.outbox).toHaveLength(2);
});

test("acceptFiles keeps only files with data", () => {
	const good = new File(["abc"], "a.pdf");
	const empty = new File([], "empty.txt");
	const { accepted, rejected } = acceptFiles([good, empty, "a.pdf", null]);
	expect(accepted).toEqual([good]);
	expect(rejected).toEqual([empty, "a.pdf", null]);
});

test("formatSize", () => {
	expect(formatSize(512)).toBe("512 B");
	expect(formatSize(1536)).toBe("1.5 KB");
	expect(formatSize(12 * 1024 * 1024)).toBe("12 MB");
});

test("nextGeminiStatus claims only what a reply proves", () => {
	const unknown = { kind: "unknown" } as const;
	expect(nextGeminiStatus(unknown, { kind: "ready", value: 1 })).toEqual({
		kind: "ready",
	});
	const down = nextGeminiStatus(unknown, {
		kind: "unavailable",
		message: "GEMINI_API_KEY is not set",
	});
	expect(down).toEqual({
		kind: "unavailable",
		message: "GEMINI_API_KEY is not set",
	});
	expect(nextGeminiStatus(down, { kind: "error", message: "502" })).toBe(down);
	expect(nextGeminiStatus(unknown, { kind: "signed_out" })).toBe(unknown);
});

test("evidenceLine", () => {
	const evidence = {
		id: "1",
		familyId: "1",
		metric: "heart_rate",
		value: 72,
		unit: "bpm",
		sourceTime: "T",
		receivedAt: "T",
		source: "Watch",
		synthetic: false,
		quality: "validated" as const,
		stale: false,
	};
	const at = (iso: string) => `at ${iso}`;
	expect(evidenceLine(evidence, at)).toBe("heart_rate 72 bpm · Watch · at T");
	expect(evidenceLine({ ...evidence, stale: true }, at)).toBe(
		"heart_rate 72 bpm · Watch · at T · stale",
	);
});

test("timeline interleaves messages and asks by time", () => {
	const ask: Ask = {
		id: "a",
		question: "q",
		askedAt: "2026-10-04T00:00:30.000Z",
		state: { kind: "pending" },
	};
	const early = { ...msg("1"), sentAt: "2026-10-04T00:00:00.000Z" };
	const late = { ...msg("2"), sentAt: "2026-10-04T00:01:00.000Z" };
	expect(timeline([early, late], [ask]).map((item) => item.at)).toEqual([
		early.sentAt,
		ask.askedAt,
		late.sentAt,
	]);
});
