import type {
	ExerciseDemand,
	ExercisePlan,
	ExerciseSession,
	StopReason,
} from "@health/contracts/exercise";

/**
 * The verified plan to invite the wearer to at `now`: inside its local time window and not yet
 * answered (declined or started) today. A window may run past midnight.
 */
export const invitation = (
	plans: readonly ExercisePlan[],
	sessions: readonly ExerciseSession[],
	now: Date,
): ExercisePlan | null => {
	const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const today = now.toDateString();
	return (
		plans.find((plan) => {
			const { windowStart: start, windowEnd: end } = plan;
			const open =
				start <= end
					? time >= start && time < end
					: time >= start || time < end;
			const answered = sessions.some(
				(s) =>
					s.planId === plan.id && new Date(s.openedAt).toDateString() === today,
			);
			return plan.verification !== null && open && !answered;
		}) ?? null
	);
};

export const demandText: Record<ExerciseDemand, string> = {
	standing: "Standing",
	walking: "Walking",
	floor: "Getting down to the floor",
	overhead_arms: "Arms above the head",
	weights: "Holding weights",
};

export const outcomeText: Record<ExerciseSession["outcome"], string> = {
	declined: "Declined",
	completed: "Completed",
	stopped: "Stopped",
	// Started with no recorded finish: never counted as completed.
	unfinished: "Started, no finish recorded",
};

export const reasonText: Record<StopReason, string> = {
	wearer: "the wearer chose to stop",
	pain: "pain",
	dizziness: "dizziness",
	distress: "feeling unwell",
};
