import { expect, spyOn, test } from "bun:test";
import type { FamilyAnswer } from "@health/contracts/ask";
import type { Message, Space } from "@spectrum-ts/core";
import { iMessageHandler, unavailableReply } from "./agent";
import type { WearerActions } from "./finder";

const sent: string[] = [];
// Everything the agent did in the space, in order: the read receipt, typing, and each reply.
const events: string[] = [];
const signals = {
	read: async () => {
		events.push("read");
	},
	startTyping: async () => {
		events.push("typing on");
	},
	stopTyping: async () => {
		events.push("typing off");
	},
};
const space = {
	...signals,
	send: async (text: string) => {
		sent.push(text);
		events.push(text);
	},
} as unknown as Space;
const message = (
	text: string | undefined,
	sender = "+15550001111",
	direction = "inbound",
) =>
	({
		id: crypto.randomUUID(),
		timestamp: new Date(),
		direction,
		sender: { id: sender },
		content:
			text === undefined ? { type: "attachment" } : { type: "text", text },
	}) as unknown as Message;

test("answers allowlisted text once and skips everything else", async () => {
	sent.length = 0;
	events.length = 0;
	const asked: [bigint, string][] = [];
	const handle = iMessageHandler({
		senders: new Map([["+15550001111", 7n]]),
		answer: async (familyId, { question }) => {
			asked.push([familyId, question]);
			if (question === "boom") throw new Error("down");
			return { answer: `re: ${question}` } as FamilyAnswer;
		},
		wearer: undefined,
	});
	const first = message("hi?");
	for (const item of [
		first,
		message("who are you?", "+19990000000"),
		message("echo", "+15550001111", "outbound"),
		message(undefined),
		message("boom"),
		// A webhook retry delivers the same message again.
		first,
		message("after?"),
	])
		await handle(space, item);
	expect(asked).toEqual([
		[7n, "hi?"],
		[7n, "boom"],
		[7n, "after?"],
	]);
	expect(sent).toEqual(["re: hi?", unavailableReply, "re: after?"]);
	// Each answered message is marked read and shows typing before its reply; skipped ones get neither.
	expect(events).toEqual(
		["re: hi?", unavailableReply, "re: after?"].flatMap((reply) => [
			"read",
			"typing on",
			reply,
			"typing off",
		]),
	);
});

test("item questions, done replies, and photos go to the wearer actions", async () => {
	sent.length = 0;
	const calls: string[] = [];
	const wearer: WearerActions = {
		findItem: async (familyId, item) => {
			calls.push(`find ${familyId} ${item}`);
			return `found ${item}`;
		},
		done: async (familyId, words) => {
			calls.push(`done ${familyId} ${words}`);
			return "noted";
		},
		savePhoto: async (familyId, image) => {
			calls.push(`photo ${familyId} ${image.type} ${image.data}`);
			return "saved";
		},
	};
	const handle = iMessageHandler({
		senders: new Map([["+15550001111", 7n]]),
		answer: async (_, { question }) =>
			({ answer: `re: ${question}` }) as FamilyAnswer,
		wearer,
	});
	const photo = (mimeType: string) =>
		({
			id: crypto.randomUUID(),
			timestamp: new Date(),
			direction: "inbound",
			sender: { id: "+15550001111" },
			content: {
				type: "attachment",
				mimeType,
				read: async () => Buffer.from("img"),
			},
		}) as unknown as Message;
	for (const item of [
		message("Where did I put my blood pressure pills this morning?"),
		message("I can't find my keys"),
		message("Done"),
		message("I ate lunch"),
		message("where is my daughter?"),
		photo("image/HEIC"),
		photo("application/pdf"),
	])
		await handle(space, item);
	expect(calls).toEqual([
		"find 7 blood pressure pills",
		"find 7 keys",
		"done 7 Done",
		"done 7 I ate lunch",
		"photo 7 image/heic aW1n",
	]);
	expect(sent).toEqual([
		"found blood pressure pills",
		"found keys",
		"noted",
		"noted",
		"re: where is my daughter?",
		"saved",
		"Please send a photo or a short text.",
	]);
});

test("a failed reply, read receipt, or typing signal does not stop later answers", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const warnings = spyOn(console, "warn").mockImplementation(() => {});
	const delivered: string[] = [];
	let attempts = 0;
	const flaky = {
		...signals,
		read: async () => {
			throw new Error("receipts down");
		},
		send: async (text: string) => {
			attempts += 1;
			if (attempts === 1) throw new Error("carrier down");
			delivered.push(text);
		},
	} as unknown as Space;
	try {
		const handle = iMessageHandler({
			senders: new Map([["+15550001111", 7n]]),
			answer: async (_, { question }) =>
				({ answer: `re: ${question}` }) as FamilyAnswer,
			wearer: undefined,
		});
		await handle(flaky, message("first?"));
		await handle(flaky, message("second?"));
		expect(delivered).toEqual(["re: second?"]);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveBeenCalledTimes(2);
	} finally {
		errors.mockRestore();
		warnings.mockRestore();
	}
});
