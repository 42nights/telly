// Pin a remembered medicine container in AR, and show it later (contract: telly-ar-pin). The
// container id is the sighting id, which stays the same for one container name in a family. The
// world map is a scan of the person's home: it goes only to the shell and to the family's server.
import type { MedicineSighting } from "@health/contracts/medicine-memory";
import { Schema } from "effect";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";
import { type ArFailure, findPin, savePin } from "@/lib/ar-bridge";

/** The end of one AR flow, as the finder shows it. */
export type ArOutcome =
	| { readonly kind: "done"; readonly text: string }
	| {
			readonly kind: "failed";
			readonly code: ArFailure["code"] | "api" | "no-pin";
			readonly title: string;
			readonly text: string;
	  };

// The replies hold more (the `MedicineArPin` contract); the finder reads only these fields.
const SavedPin = Schema.Struct({ anchorId: Schema.String });
const StoredPin = Schema.Struct({
	anchorId: Schema.String,
	worldMap: Schema.String,
});

const pinPath = (familyId: string, containerId: string) =>
	familyPath(
		familyId,
		`/medicine-memory/containers/${encodeURIComponent(containerId)}/ar-pin`,
	);

const arFailed = (failure: ArFailure, flow: "pin" | "find"): ArOutcome => {
	const failed = (title: string, text: string): ArOutcome => ({
		kind: "failed",
		code: failure.code,
		title,
		text,
	});
	switch (failure.code) {
		case "cancelled":
			return failed(
				"AR closed",
				flow === "pin"
					? "You closed the AR screen. Nothing was pinned."
					: "You closed the AR screen before the marker showed.",
			);
		case "camera-denied":
			return failed(
				"Camera is off for Telly",
				"Allow the camera for Telly in iPhone Settings, then try again.",
			);
		case "relocalization-failed":
			return failed(
				"I could not recognize the room",
				"Stand where you pinned it, turn on the lights, and move your phone slowly around the room. Then try again.",
			);
		case "mapping-not-ready":
			return failed(
				"I need to see more of the room",
				"Move your phone slowly around the room before you tap Pin here.",
			);
		case "timeout":
			return failed("AR did not answer", "Close the AR screen and try again.");
		case "failed":
			return failed("AR did not work", failure.message);
	}
};

const apiFailed = (failure: ApiFailure, title: string): ArOutcome => ({
	kind: "failed",
	code: "api",
	title,
	text: failure.kind === "signed_out" ? "Sign in first." : failure.message,
});

/** Opens AR to pin the container, then stores the anchor and world map on the server. */
export const pinInAr = async (
	familyId: string,
	sighting: MedicineSighting,
): Promise<ArOutcome> => {
	const pin = await savePin({
		familyId,
		containerId: sighting.id,
		label: sighting.container,
	});
	if (pin.kind === "error") return arFailed(pin, "pin");
	const stored = await apiRequest(SavedPin, pinPath(familyId, sighting.id), {
		method: "PUT",
		body: { anchorId: pin.anchorId, worldMap: pin.worldMap },
	});
	if (stored.kind !== "ready")
		return apiFailed(stored, "I could not save the AR pin");
	return {
		kind: "done",
		text: `Pinned ${sighting.container} in AR. Tap “Show me in AR” to find this spot later.`,
	};
};

/** Reads the stored pin, then opens AR to relocalize and show the marker at it. */
export const showInAr = async (
	familyId: string,
	sighting: MedicineSighting,
): Promise<ArOutcome> => {
	const stored = await apiRequest(StoredPin, pinPath(familyId, sighting.id));
	if (stored.kind === "error" && stored.status === 404)
		return {
			kind: "failed",
			code: "no-pin",
			title: "No AR pin yet",
			text: `Stand by ${sighting.container} and tap “Pin it in AR” first.`,
		};
	if (stored.kind !== "ready")
		return apiFailed(stored, "I could not read the AR pin");
	const found = await findPin({
		containerId: sighting.id,
		label: sighting.container,
		anchorId: stored.value.anchorId,
		worldMap: stored.value.worldMap,
	});
	return found.kind === "found"
		? {
				kind: "done",
				text: `The marker showed where you pinned ${sighting.container}.`,
			}
		: arFailed(found, "find");
};
