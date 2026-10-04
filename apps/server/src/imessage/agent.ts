// Answers family questions sent over iMessage. Provider-independent: it handles one Spectrum message
// and replies in the same space. Only allowlisted senders get answers; message text and addresses
// never reach the logs.
import { type FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import type { Message, Space } from "@spectrum-ts/core";
import { Schema } from "effect";

export const unavailableReply =
	"Telly cannot answer right now. Please try again later or ask a family member.";
const invalidReply = "Please send a short text question.";

/** The handler for each delivered message. Webhooks deliver at least once, so a message id that was
 * seen before gets no second reply. */
export const iMessageHandler = (deps: {
	readonly senders: ReadonlyMap<string, bigint>;
	readonly answer: (
		familyId: bigint,
		question: FamilyQuestion,
	) => Promise<FamilyAnswer>;
}) => {
	let ignored = 0;
	// ponytail: the last 1000 ids of this process only; a retry that reaches a new container can get a second reply.
	const seen = new Set<string>();
	return async (space: Space, message: Message) => {
		if (seen.has(message.id)) return;
		seen.add(message.id);
		if (seen.size > 1000) seen.delete(seen.values().next().value as string);
		if (message.direction === "outbound" || message.content.type !== "text")
			return;
		const familyId = deps.senders.get(message.sender?.id.trim() ?? "");
		if (familyId === undefined) {
			ignored += 1;
			console.warn(
				`imessage: ignored message from unknown sender (${ignored})`,
			);
			return;
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
	};
};
