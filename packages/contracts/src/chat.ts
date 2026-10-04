// Family chat: family messages, under `/api/families/:familyId`.
import { Schema } from "effect";
import { FamilyMessage } from "./index";

/**
 * `POST /messages` body. The client creates `clientId` once per message and reuses it for every
 * resend, so a send repeated after a lost reply stores the message once.
 */
export const SendFamilyMessage = Schema.Struct({
	clientId: Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9_-]+$/),
		Schema.isMaxLength(128),
	),
	body: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000)),
});
export type SendFamilyMessage = typeof SendFamilyMessage.Type;

/** `GET /messages?after=<id>`: the family's messages after that id, oldest first, at most 200. */
export const FamilyMessages = Schema.Struct({
	messages: Schema.Array(FamilyMessage),
});
export type FamilyMessages = typeof FamilyMessages.Type;
