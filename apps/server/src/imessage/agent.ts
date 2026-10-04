// Answers family questions sent over iMessage. Provider-independent: it handles one Spectrum message
// and replies in the same space. Only allowlisted senders get answers; message text and addresses
// never reach the logs. For the wearer (#308), "where are my keys?" gets the last place and a finder
// link, "done" answers the texted reminder, and a photo saves where an item is.
import { type FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import type { FinderImage } from "@health/contracts/finder-link";
import type { Message, Space } from "@spectrum-ts/core";
import { Schema } from "effect";
import { isDoneReply, itemAsk, type WearerActions } from "./finder";

export const unavailableReply =
	"Telly cannot answer right now. Please try again later or ask a family member.";
const invalidReply = "Please send a short text question.";

// Photo types Gemini reads. iPhone photos arrive as HEIC.
const photoTypes: Record<string, FinderImage["type"]> = {
	"image/jpeg": "image/jpeg",
	"image/png": "image/png",
	"image/webp": "image/webp",
	"image/heic": "image/heic",
	"image/heif": "image/heif",
};
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** The handler for each delivered message. Webhooks deliver at least once, so a message id that was
 * seen before gets no second reply. */
export const iMessageHandler = (deps: {
	readonly senders: ReadonlyMap<string, bigint>;
	readonly answer: (
		familyId: bigint,
		question: FamilyQuestion,
	) => Promise<FamilyAnswer>;
	/** Undefined without the delivery operator: item questions then go to `answer`. */
	readonly wearer: WearerActions | undefined;
}) => {
	let ignored = 0;
	// ponytail: the last 1000 ids of this process only; a retry that reaches a new container can get a second reply.
	const seen = new Set<string>();

	/** The reply text, or undefined for a message that gets none. */
	const replyTo = async (
		familyId: bigint,
		content: Message["content"],
	): Promise<string | undefined> => {
		const { wearer } = deps;
		if (content.type === "attachment") {
			if (wearer === undefined) return undefined;
			const type = photoTypes[content.mimeType.toLowerCase()];
			if (type === undefined) return undefined;
			const bytes = await content.read();
			if (bytes.length > MAX_PHOTO_BYTES)
				return "That photo is too large. Please send a smaller one.";
			return wearer.savePhoto(familyId, {
				type,
				data: bytes.toString("base64"),
			});
		}
		if (content.type !== "text") return undefined;
		if (wearer !== undefined && isDoneReply(content.text))
			return wearer.done(familyId, content.text);
		const item = itemAsk(content.text);
		if (wearer !== undefined && item !== undefined)
			return wearer.findItem(familyId, item);
		const question = Schema.decodeUnknownOption(FamilyQuestion)({
			question: content.text,
		});
		if (question._tag === "None") return invalidReply;
		return (await deps.answer(familyId, question.value)).answer;
	};

	return async (space: Space, message: Message) => {
		if (seen.has(message.id)) return;
		seen.add(message.id);
		if (seen.size > 1000) seen.delete(seen.values().next().value as string);
		if (message.direction === "outbound") return;
		const familyId = deps.senders.get(message.sender?.id.trim() ?? "");
		if (familyId === undefined) {
			ignored += 1;
			console.warn(
				`imessage: ignored message from unknown sender (${ignored})`,
			);
			return;
		}
		let reply: string | undefined;
		try {
			reply = await replyTo(familyId, message.content);
		} catch (error) {
			console.error("imessage: answer failed", error);
			reply = unavailableReply;
		}
		if (reply === undefined) return;
		try {
			await space.send(reply);
		} catch (error) {
			console.error("imessage: send failed", error);
		}
	};
};
