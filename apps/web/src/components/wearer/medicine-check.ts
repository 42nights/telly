import type { FamilyList } from "@health/contracts/families";
import {
	MAX_VISION_IMAGE_BYTES,
	type MedicineDetection,
	MedicineDetections,
} from "@health/contracts/vision";
import { useEffect, useRef, useState } from "react";

import {
	type ApiFailure,
	type ApiResult,
	type ApiState,
	apiRequest,
	familyPath,
} from "@/lib/api";

export type CheckResult =
	| { readonly kind: "looking" }
	| {
			readonly kind: "done";
			readonly detections: readonly MedicineDetection[];
	  }
	| ApiFailure;

export type PictureCheck = {
	readonly id: string;
	/** The JPEG data URL that was sent, shown in place of the live video. */
	readonly picture: string;
	readonly frame: { readonly width: number; readonly height: number };
	readonly capturedAt: number;
	readonly result: CheckResult;
};

type Frame = {
	readonly picture: string;
	readonly data: string;
	readonly width: number;
	readonly height: number;
};

/** Encodes the video's current frame as JPEG, scaled down until it fits the vision limit. */
const capture = (video: HTMLVideoElement): Frame | null => {
	const width = video.videoWidth;
	const height = video.videoHeight;
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (width === 0 || height === 0 || context === null) return null;
	let scale = 1;
	for (;;) {
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		const picture = canvas.toDataURL("image/jpeg", 0.85);
		const data = picture.slice(picture.indexOf(",") + 1);
		if ((data.length * 3) / 4 <= MAX_VISION_IMAGE_BYTES)
			return { picture, data, width, height };
		scale *= 0.7;
	}
};

/** Why a picture cannot be sent when no family is selected. */
const withoutFamily = (families: ApiState<FamilyList>): CheckResult => {
	if (families.kind === "ready")
		return { kind: "error", message: "No person is paired yet." };
	if (families.kind === "loading")
		return { kind: "error", message: "Still loading. Try again." };
	return families;
};

/** The full frame, unrotated: the server maps boxes back into these pixels. */
const detectionRequest = (id: string, capturedAt: number, frame: Frame) => ({
	frame: {
		id,
		capturedAt: new Date(capturedAt).toISOString(),
		width: frame.width,
		height: frame.height,
		crop: { x: 0, y: 0, width: frame.width, height: frame.height },
		rotation: 0,
	},
	image: { type: "image/jpeg", data: frame.data },
});

const resultFor = (
	result: ApiResult<MedicineDetections>,
	id: string,
): CheckResult => {
	if (result.kind !== "ready") return result;
	if (result.value.frame.id !== id)
		return { kind: "error", message: "The reply was for another picture." };
	return { kind: "done", detections: result.value.detections };
};

/** The most confident detection, which the arrow points to. */
export const bestDetection = (detections: readonly MedicineDetection[]) =>
	detections.reduce<MedicineDetection | null>(
		(top, d) => (top === null || d.confidence > top.confidence ? d : top),
		null,
	);

/**
 * Captures the video frame and asks `POST /vision/medicine-detections` about it. A new look or
 * `stop` aborts the pending one, and a reply for another frame is never shown.
 */
export function usePictureCheck(
	familyId: string | null,
	families: ApiState<FamilyList>,
) {
	const [check, setCheck] = useState<PictureCheck | null>(null);
	const pending = useRef<AbortController | null>(null);
	useEffect(() => () => pending.current?.abort(), []);

	const stop = () => {
		pending.current?.abort();
		pending.current = null;
		setCheck(null);
	};

	const look = async (video: HTMLVideoElement | null) => {
		pending.current?.abort();
		const frame = video === null ? null : capture(video);
		if (frame === null) return setCheck(null);
		const id = crypto.randomUUID();
		const capturedAt = Date.now();
		const base = {
			id,
			picture: frame.picture,
			frame: { width: frame.width, height: frame.height },
			capturedAt,
		};
		if (familyId === null)
			return setCheck({ ...base, result: withoutFamily(families) });
		setCheck({ ...base, result: { kind: "looking" } });
		const controller = new AbortController();
		pending.current = controller;
		const result = await apiRequest(
			MedicineDetections,
			familyPath(familyId, "/vision/medicine-detections"),
			{
				method: "POST",
				signal: controller.signal,
				body: detectionRequest(id, capturedAt, frame),
			},
		).catch(() => null);
		// Drop a reply for an older picture, or one the wearer stopped.
		if (result === null || controller.signal.aborted) return;
		pending.current = null;
		setCheck({ ...base, result: resultFor(result, id) });
	};

	return { check, look, stop };
}
