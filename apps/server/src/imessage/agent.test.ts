import { expect, test } from "bun:test";
import type { FamilyAnswer } from "@health/contracts/ask";
import type { Message, Space } from "@spectrum-ts/core";
import { runIMessageAgent, unavailableReply } from "./agent";

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
		direction,
		sender: { id: sender },
		content:
			text === undefined ? { type: "attachment" } : { type: "text", text },
	}) as unknown as Message;

test("answers allowlisted text and skips everything else", async () => {
	sent.length = 0;
	const asked: [bigint, string][] = [];
	const items: [Space, Message][] = [
		[space, message("hi?")],
		[space, message("who are you?", "+19990000000")],
		[space, message("echo", "+15550001111", "outbound")],
		[space, message(undefined)],
		[space, message("boom")],
		[space, message("after?")],
	];
	await runIMessageAgent(
		(async function* () {
			yield* items;
		})(),
		{
			senders: new Map([["+15550001111", 7n]]),
			answer: async (familyId, { question }) => {
				asked.push([familyId, question]);
				if (question === "boom") throw new Error("down");
				return { answer: `re: ${question}` } as FamilyAnswer;
			},
		},
	);
	expect(asked).toEqual([
		[7n, "hi?"],
		[7n, "boom"],
		[7n, "after?"],
	]);
	expect(sent).toEqual(["re: hi?", unavailableReply, "re: after?"]);
});
