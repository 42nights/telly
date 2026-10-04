// Who wrote a message or saw an alert. No contract carries member names yet, so a member shows as
// "You" or as a short label from their identity, never as the full 64-character identity.
export const memberLabel = (identity: string, me: string | null): string =>
	identity === me ? "You" : `Member ${identity.slice(0, 6)}`;
