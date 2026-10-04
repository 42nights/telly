import {
	Meal,
	MealEstimate,
	type MealEstimateRequest,
	type MealIntakeReport,
} from "@health/contracts/meals";
import { VoiceTranscript } from "@health/contracts/voice";
import { useEffect, useRef, useState } from "react";

import { capture } from "@/components/wearer/medicine-check";
import {
	type ApiFailure,
	type ApiResult,
	apiRequest,
	familyPath,
} from "@/lib/api";

export type EstimateState =
	| { readonly kind: "idle" }
	| { readonly kind: "estimating" }
	| { readonly kind: "done"; readonly estimate: MealEstimate }
	| ApiFailure;

export type ReportState =
	| { readonly kind: "idle" }
	| { readonly kind: "saving" }
	| { readonly kind: "saved"; readonly meal: Meal; readonly saved: string }
	| ApiFailure;

const noFamily: ApiFailure = {
	kind: "error",
	message: "No person is paired yet.",
};

/** Speech to text with `POST /voice/transcriptions`; the words are never sent anywhere else. */
export const transcribe = async (
	familyId: string,
	audio: Blob,
): Promise<ApiResult<string>> => {
	const result = await apiRequest(
		VoiceTranscript,
		familyPath(familyId, "/voice/transcriptions"),
		{
			method: "POST",
			rawBody: { data: audio, type: audio.type || "audio/webm" },
		},
	);
	return result.kind === "ready"
		? { kind: "ready", value: result.value.text.trim() }
		: result;
};

/**
 * One meal: its photo, its estimate, and its intake reports, which stay separate. An estimate is
 * stored by the server with its estimator and time; it never reports intake.
 */
export function useMeal(familyId: string | null) {
	const [mealId, setMealId] = useState(() => crypto.randomUUID());
	const [photo, setPhoto] = useState<string | null>(null);
	const [estimate, setEstimate] = useState<EstimateState>({ kind: "idle" });
	const [report, setReport] = useState<ReportState>({ kind: "idle" });
	const pending = useRef<AbortController | null>(null);
	useEffect(() => () => pending.current?.abort(), []);

	const estimateFrom = async (request: MealEstimateRequest) => {
		if (familyId === null) return setEstimate(noFamily);
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		setEstimate({ kind: "estimating" });
		const result = await apiRequest(
			MealEstimate,
			familyPath(familyId, `/meals/${mealId}/estimates`),
			{ method: "POST", body: request, signal: controller.signal },
		).catch(() => null);
		if (result === null || controller.signal.aborted) return;
		pending.current = null;
		setEstimate(
			result.kind === "ready"
				? { kind: "done", estimate: result.value }
				: result,
		);
	};

	const takePhoto = (video: HTMLVideoElement | null) => {
		const frame = video === null ? null : capture(video);
		if (frame === null) return;
		setPhoto(frame.picture);
		void estimateFrom({
			source: "photo",
			capturedAt: new Date().toISOString(),
			image: { type: "image/jpeg", data: frame.data },
		});
	};

	/** `saved` is what the screen confirms, such as "you ate about half". */
	const reportIntake = async (body: MealIntakeReport, saved: string) => {
		if (familyId === null) return setReport(noFamily);
		setReport({ kind: "saving" });
		const result = await apiRequest(
			Meal,
			familyPath(familyId, `/meals/${mealId}/intake`),
			{ method: "POST", body },
		);
		setReport(
			result.kind === "ready"
				? { kind: "saved", meal: result.value, saved }
				: result,
		);
	};

	const newMeal = () => {
		pending.current?.abort();
		setMealId(crypto.randomUUID());
		setPhoto(null);
		setEstimate({ kind: "idle" });
		setReport({ kind: "idle" });
	};

	return {
		mealId,
		photo,
		estimate,
		report,
		takePhoto,
		estimateFrom,
		reportIntake,
		newMeal,
	};
}
