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
		// Read receipt and typing go out with the answer, not before it: they never delay the reply.
		// Both are best-effort; a failure only costs the indicator.
		const arrived = Date.now();
		const shown = Promise.allSettled([
			space.read(message),
			space.startTyping(),
		]).then((results) => {
			for (const result of results)
				if (result.status === "rejected")
					console.warn(
						"imessage: read receipt or typing failed",
						result.reason,
					);
		});
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
		const answered = Date.now();
		// Typing must start before the reply, or the indicator would stay after it.
		await shown;
		try {
			await space.send(reply);
		} catch (error) {
			console.error("imessage: send failed", error);
		}
		const sent = Date.now();
		const written = message.timestamp.getTime();
		console.log(
			`imessage: replied ${sent - written} ms after the message was written (delivery ${arrived - written} ms, answer ${answered - arrived} ms, send ${sent - answered} ms)`,
		);
		// Also clears the indicator after a failed send.
		await space.stopTyping().catch(() => {});
	};
};
