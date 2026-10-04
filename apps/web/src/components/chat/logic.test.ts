import { expect, test } from "bun:test";

import {
	type Ask,
	attachFiles,
	evidenceLine,
	formatSize,
	mergeMessages,
	nextGeminiStatus,
	outboxFor,
	timeline,
	toAttachment,
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

test("attachFiles keeps every file and marks the ones over the limits", () => {
	const MiB = 1024 * 1024;
	const file = (name: string, size: number, type = "application/pdf") =>
		new File([new Uint8Array(size)], name, { type });
	const tray = attachFiles(
		[],
		[
			file("a.exe", 10, "application/x-msdownload"),
			file("empty.pdf", 0),
			file("big.pdf", 5 * MiB + 1),
			file("1.pdf", 4 * MiB),
			file("2.pdf", 4 * MiB),
			file("3.pdf", 1),
		],
	);
	expect(tray.map((entry) => [entry.file.name, entry.error])).toEqual([
		["a.exe", "Type not supported"],
		["empty.pdf", "Empty file"],
		["big.pdf", "Over 5 MB"],
		["1.pdf", null],
		["2.pdf", null],
		["3.pdf", "Over 8 MB in total"],
	]);
	const txt = (n: number) => file(`${n}.txt`, 1, "text/plain");
	const full = attachFiles(
		attachFiles([], [1, 2, 3].map(txt)),
		[4, 5].map(txt),
	);
	expect(full.map((entry) => entry.error)).toEqual([
		null,
		null,
		null,
		null,
		"Over 4 files",
	]);
});

test("toAttachment sends the file bytes as base64", async () => {
	const attachment = await toAttachment(
		new File(["hello"], "note.txt", { type: "text/plain" }),
	);
	expect(attachment).toEqual({
		name: "note.txt",
		mimeType: "text/plain",
		data: btoa("hello"),
	});
});

test("outboxFor reuses the clientId only for a resend of the same text", () => {
	const first = outboxFor(null, "hi");
	expect(outboxFor(first, "hi")).toBe(first);
	const edited = outboxFor(first, "hi there");
	expect(edited.clientId).not.toBe(first.clientId);
	expect(edited.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
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
	expect(evidenceLine({ ...evidence, synthetic: true }, at)).toBe(
		"heart_rate 72 bpm · Watch · at T · demo, not real",
	);
});

test("timeline interleaves messages and asks by time", () => {
	const ask: Ask = {
		id: "a",
		question: "q",
		files: [],
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
