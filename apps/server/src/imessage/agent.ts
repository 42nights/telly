// Answers family questions sent over iMessage. Provider-independent: it reads Spectrum messages and
// replies in the same space. Only allowlisted senders get answers; message text and addresses never reach the logs.
import { type FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import type { Message, Space } from "@spectrum-ts/core";
import { Schema } from "effect";

export const unavailableReply =
	"Telly cannot answer right now. Please try again later or ask a family member.";
const invalidReply = "Please send a short text question.";

export const runIMessageAgent = async (
	messages: AsyncIterable<[Space, Message]>,
	deps: {
		readonly senders: ReadonlyMap<string, bigint>;
		readonly answer: (
			familyId: bigint,
			question: FamilyQuestion,
		) => Promise<FamilyAnswer>;
	},
) => {
	let ignored = 0;
	for await (const [space, message] of messages) {
		if (message.direction === "outbound" || message.content.type !== "text")
			continue;
		const familyId = deps.senders.get(message.sender?.id.trim() ?? "");
		if (familyId === undefined) {
			ignored += 1;
			console.warn(
				`imessage: ignored message from unknown sender (${ignored})`,
			);
			continue;
		}
		const question = Schema.decodeUnknownOption(FamilyQuestion)({
			question: message.content.text,
		});
		let reply = invalidReply;
		if (question._tag === "Some") {
			try {
				reply = (await deps.answer(familyId, question.value)).answer;
			} catch (error) {
				console.error("imessage: answer failed", error);
				reply = unavailableReply;
			}
		}
		try {
			await space.send(reply);
		} catch (error) {
			console.error("imessage: send failed", error);
		}
	}
};
