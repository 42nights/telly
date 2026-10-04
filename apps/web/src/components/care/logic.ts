// Pure rules for the Care screen: which answers the caller may send for a need, and the words for
// each state. The server checks the same rules again; this only hides buttons that would be refused.
import type {
	AttemptStatus,
	CareNeed,
	CareResponse,
	NeedKind,
	NeedStatus,
} from "@health/contracts/care";

export const kindLabel: Record<NeedKind, string> = {
	alert: "Health alert",
	help: "Request for help",
	call_reminder: "Call reminder",
};

export const needStatusLabel: Record<NeedStatus, string> = {
	open: "Waiting for someone to accept",
	accepted: "Accepted, help not confirmed yet",
	resolved: "Help confirmed",
	unresolved: "Unresolved: nobody accepted",
};

export const attemptLabel: Record<AttemptStatus, string> = {
	queued: "Queued",
	sent: "Sent",
	delivered: "Delivered",
	answered: "Call answered",
	accepted: "Accepted",
	declined: "Declined",
	no_answer: "No answer",
	follow_up_expired: "Follow-up expired",
};

const WAITING: Partial<Record<AttemptStatus, true>> = {
	sent: true,
	delivered: true,
	answered: true,
};

/** The answers `me` may send now, in button order. */
export const actionsFor = (
	need: CareNeed,
	me: string | null,
): CareResponse["response"][] => {
	if (me === null) return [];
	if (need.status === "accepted")
		return need.acceptedBy === me ? ["help_confirmed"] : [];
	const current = need.attempts.at(-1);
	if (
		need.status !== "open" ||
		current?.member !== me ||
		WAITING[current.status] !== true
	)
		return [];
	return [
		...(current.status === "sent" ? (["seen"] as const) : []),
		...(current.channel === "call" && current.status !== "answered"
			? (["answer"] as const)
			: []),
		"accept",
		"decline",
	];
};
