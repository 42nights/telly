import { FamilyMembers } from "@health/contracts/families";

import { familyPath, useApi } from "./api";

// Who wrote a message or saw an alert, on screens that do not read the member list
// (`useMemberNames`): "You" or a short label from the identity, never the full identity.
export const memberLabel = (identity: string, me: string | null): string =>
	identity === me ? "You" : `Member ${identity.slice(0, 6)}`;

/**
 * The members of a family and a label for each (#302): the name they signed in with, or the part of
 * their email before the @. A member who has not opened the app since names were stored has
 * neither yet and shows as `memberLabel`.
 */
export function useMemberNames(familyId: string | null) {
	const state = useApi(
		FamilyMembers,
		familyId === null ? null : familyPath(familyId, "/members"),
	);
	const members = state.kind === "ready" ? state.value.members : [];
	const nameOf = (identity: string) =>
		members.find((m) => m.identity === identity)?.name ??
		memberLabel(identity, null);
	return { state, members, nameOf };
}

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
