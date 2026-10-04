// Who wrote a message or saw an alert. No contract carries member names yet, so a member shows as
// "You" or as a short label from their identity, never as the full 64-character identity.
export const memberLabel = (identity: string, me: string | null): string =>
	identity === me ? "You" : `Member ${identity.slice(0, 6)}`;

/**
 * Whether the server's alert worker posted this family message. It uses the client id
 * `alert-<alertId>`, which members cannot use.
 */
export const isAlertMessage = (message: { readonly clientId: string }) =>
	message.clientId.startsWith("alert-");

/** Who wrote a family message. */
export const senderLabel = (
	message: { readonly sender: string; readonly clientId: string },
	me: string | null,
): string =>
	isAlertMessage(message) ? "Telly alert" : memberLabel(message.sender, me);
