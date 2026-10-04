// Answers family questions sent over iMessage. Provider-independent: it handles one Spectrum message
// and replies in the same space. Only allowlisted senders and members' saved phone numbers get
// answers; message text and addresses never reach the logs. For the wearer (#308), "where are my
// keys?" gets the last place and a finder link, "done" answers the texted reminder, and a photo
// saves where an item is.
import { type FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import type { FinderImage } from "@health/contracts/finder-link";
import type { Message, Space } from "@spectrum-ts/core";
import { Schema } from "effect";
import type { Identity } from "spacetimedb";
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

/** A member's saved phone number in one of their families (the `member_phones` view). */
export type SenderPhone = {
	readonly phone: string;
	readonly member: Identity;
	readonly familyId: bigint;
};

/**
 * The member who saved `sender` as their phone, in their oldest family (lowest id), or undefined.
 * The module keeps each number to one member, so only the family can be ambiguous.
 */
export const senderMember = (phones: Iterable<SenderPhone>, sender: string) => {
	let found: SenderPhone | undefined;
	for (const row of phones)
		if (
			row.phone === sender &&
			(found === undefined || row.familyId < found.familyId)
		)
			found = row;
	return found;
};

type Deps = {
	readonly senders: ReadonlyMap<string, bigint>;
	/** Saved member phones, read when a sender is not allowlisted; undefined without the operator. */
	readonly memberPhones?: (() => Promise<Iterable<SenderPhone>>) | undefined;
	readonly answer: (
		familyId: bigint,
		question: FamilyQuestion,
	) => Promise<FamilyAnswer>;
	/** Undefined without the delivery operator: item questions then go to `answer`. */
	readonly wearer: WearerActions | undefined;
};

/** The reply to a photo: the wearer actions save what it shows. */
const photoReply = async (
	wearer: WearerActions,
	familyId: bigint,
	photo: { readonly mimeType: string; readonly read: () => Promise<Buffer> },
) => {
	const type = photoTypes[photo.mimeType.toLowerCase()];
	if (type === undefined) return "Please send a photo or a short text.";
	const bytes = await photo.read();
	if (bytes.length > MAX_PHOTO_BYTES)
		return "That photo is too large. Please send a smaller one.";
	return wearer.savePhoto(familyId, {
		type,
		data: bytes.toString("base64"),
	});
};

/** The reply to a text: a wearer action, or the family question flow. */
const textReply = async (deps: Deps, familyId: bigint, text: string) => {
	const { wearer } = deps;
	if (wearer !== undefined && isDoneReply(text))
		return wearer.done(familyId, text);
	const item = itemAsk(text);
	if (wearer !== undefined && item !== undefined)
		return wearer.findItem(familyId, item);
	const question = Schema.decodeUnknownOption(FamilyQuestion)({
		question: text,
	});
	if (question._tag === "None") return invalidReply;
	return (await deps.answer(familyId, question.value)).answer;
};

/** The reply text; a failure becomes the "cannot answer" reply. */
const replyTo = (deps: Deps, familyId: bigint, content: Message["content"]) =>
	(content.type === "attachment" && deps.wearer !== undefined
		? photoReply(deps.wearer, familyId, content)
		: textReply(deps, familyId, content.type === "text" ? content.text : "")
	).catch((error: unknown) => {
		console.error("imessage: answer failed", error);
		return unavailableReply;
	});

/** The handler for each delivered message. Webhooks deliver at least once, so a message id that was
 * seen before gets no second reply. */
export const iMessageHandler = (deps: Deps) => {
	let ignored = 0;
	// ponytail: the last 1000 ids of this process only; a retry that reaches a new container can get a second reply.
	const seen = new Set<string>();

	/** True the first time a message id arrives. */
	const isNew = (id: string) => {
		if (seen.has(id)) return false;
		seen.add(id);
		if (seen.size > 1000) seen.delete(seen.values().next().value as string);
		return true;
	};

	/** Only inbound text, and a photo for the wearer actions, get an answer. */
	const answerable = ({ direction, content }: Message) =>
		direction !== "outbound" &&
		(content.type === "text" ||
			(content.type === "attachment" && deps.wearer !== undefined));

	return async (space: Space, message: Message) => {
		if (!isNew(message.id) || !answerable(message)) return;
		const { content } = message;
		const sender = message.sender?.id.trim() ?? "";
		// A failed read of the saved phones leaves the sender unknown, so it gets no reply.
		const familyId =
			deps.senders.get(sender) ??
			(deps.memberPhones === undefined
				? undefined
				: senderMember(
						await deps.memberPhones().catch((error: unknown) => {
							console.error("imessage: reading member phones failed", error);
							return [];
						}),
						sender,
					)?.familyId);
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
		const reply = await replyTo(deps, familyId, content);
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
