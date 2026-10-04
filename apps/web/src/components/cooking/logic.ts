// One-step-at-a-time preparation (#42). The wearer sets the pace: nothing advances on its own, a
// paused session ignores every control except resume and stop, and a step that needs a helper
// cannot be passed until the wearer says the helper is there.

export type Session = {
	readonly step: number;
	readonly paused: boolean;
	readonly explaining: boolean;
	/** The wearer said a helper is with them for the current step. */
	readonly helperHere: boolean;
	readonly ended: "finished" | "stopped" | null;
};

export type SessionAction =
	| "next"
	| "explain"
	| "pause"
	| "resume"
	| "helper_here"
	| "stop";

export const startSession: Session = {
	step: 0,
	paused: false,
	explaining: false,
	helperHere: false,
	ended: null,
};

export const advance = (
	session: Session,
	action: SessionAction,
	steps: readonly { readonly helper: boolean }[],
): Session => {
	if (session.ended !== null) return session;
	if (action === "stop") return { ...session, ended: "stopped" };
	if (action === "resume") return { ...session, paused: false };
	if (session.paused) return session;
	switch (action) {
		case "pause":
			return { ...session, paused: true };
		case "explain":
			return { ...session, explaining: !session.explaining };
		case "helper_here":
			return { ...session, helperHere: true };
		case "next": {
			if (steps[session.step]?.helper === true && !session.helperHere)
				return session;
			return session.step + 1 >= steps.length
				? { ...session, ended: "finished" }
				: { ...startSession, step: session.step + 1 };
		}
	}
};
