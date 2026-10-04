import { expect, spyOn, test } from "bun:test";
import type { FamilyAnswer } from "@health/contracts/ask";
import type { Message, Space } from "@spectrum-ts/core";
import { iMessageHandler, unavailableReply } from "./agent";

const sent: string[] = [];
const space = {
	send: async (text: string) => {
		sent.push(text);
	},
} as unknown as Space;
const message = (
	text: string | undefined,
	sender = "+15550001111",
	direction = "inbound",
) =>
	({
		id: crypto.randomUUID(),
		direction,
		sender: { id: sender },
		content:
			text === undefined ? { type: "attachment" } : { type: "text", text },
	}) as unknown as Message;

test("answers allowlisted text once and skips everything else", async () => {
	sent.length = 0;
	const asked: [bigint, string][] = [];
	const handle = iMessageHandler({
		senders: new Map([["+15550001111", 7n]]),
		answer: async (familyId, { question }) => {
			asked.push([familyId, question]);
			if (question === "boom") throw new Error("down");
			return { answer: `re: ${question}` } as FamilyAnswer;
		},
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
});

test("a failed reply does not stop later answers", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const delivered: string[] = [];
	let attempts = 0;
	const flaky = {
		send: async (text: string) => {
			attempts += 1;
			if (attempts === 1) throw new Error("carrier down");
			delivered.push(text);
		},
	} as unknown as Space;
	try {
		await runIMessageAgent(
			(async function* () {
				yield [flaky, message("first?")] as [Space, Message];
				yield [flaky, message("second?")] as [Space, Message];
			})(),
			{
				senders: new Map([["+15550001111", 7n]]),
				answer: async (_, { question }) =>
					({ answer: `re: ${question}` }) as FamilyAnswer,
			},
		);
		expect(delivered).toEqual(["re: second?"]);
		expect(errors).toHaveBeenCalledTimes(1);
	} finally {
		errors.mockRestore();
	}
});
