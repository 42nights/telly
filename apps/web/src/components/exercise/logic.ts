import type {
	ExerciseDemand,
	ExerciseSession,
	StopReason,
} from "@health/contracts/exercise";

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
