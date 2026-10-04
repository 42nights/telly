// Pin a remembered object in AR, and show it later (contract: telly-ar-pin; #301). The
// object id is the sighting id, which stays the same for one object name of a member. The
// world map is a scan of the person's home: it goes only to the shell and to the family's server.
// While the AR screen runs, it follows the member's other pinned objects too (#351). A pin joins
// the member's room map, and every pin in a saved map gets that map, so finding any of them shows
// all of them. When the screen's vision check sees a pinned object at a new spot, this saves the
// new sighting and room map.
import type {
	MedicineSighting,
	RememberMedicine,
} from "@health/contracts/medicine-memory";
import {
	type ObjectDetection,
	ObjectDetections,
} from "@health/contracts/vision";
import { Schema } from "effect";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";
import {
	type ArEvent,
	type ArFailure,
	type CheckAnswer,
	findPin,
	type MapPin,
	type PinnedObject,
	savePin,
	watchAr,
} from "@/lib/ar-bridge";
import type { MedicineMemoryChange } from "@/lib/medicine-memory";
import { detectionRequest, thumbnail } from "./medicine-check";

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

const pinPath = (familyId: string, objectId: string) =>
	familyPath(
		familyId,
		`/medicine-memory/objects/${encodeURIComponent(objectId)}/ar-pin`,
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

/** What an AR flow needs about the member: all their saved things, and how to change them. */
export type ArMember = {
	readonly sightings: readonly MedicineSighting[];
	readonly change: MedicineMemoryChange;
};

/** The member's other pinned things, which the AR screen follows too. */
const othersOf = (
	sightings: readonly MedicineSighting[],
	objectId: string,
): PinnedObject[] =>
	sightings
		.filter((s) => s.pinned && s.id !== objectId)
		.map((s) => ({ objectId: s.id, label: s.container }));

/**
 * The saved thing a confident detection is, or `undefined`. The kind must match and the name must
 * match exactly, or else be part of the other name ("keys" and "car keys") for only one saved thing.
 */
export const objectFor = (
	detection: ObjectDetection,
	sightings: readonly MedicineSighting[],
): MedicineSighting | undefined => {
	const seen = detection.label?.trim().toLowerCase() ?? "";
	if (detection.needsVerification || seen === "") return undefined;
	const kind = sightings.filter((s) => s.category === detection.category);
	const exact = kind.find((s) => s.container.trim().toLowerCase() === seen);
	if (exact !== undefined) return exact;
	const near = kind.filter((s) => {
		const saved = s.container.trim().toLowerCase();
		return saved.includes(seen) || seen.includes(saved);
	});
	return near.length === 1 ? near[0] : undefined;
};

const MOVED = /^New spot, seen in AR \(was: (.*)\)$/;

/** The place of a sighting the AR vision check saw away from its pin; it keeps the first place. */
export const movedPlace = (place: string) => {
	const text = `New spot, seen in AR (was: ${MOVED.exec(place)?.[1] ?? place})`;
	return text.length <= 120 ? text : "New spot, seen in AR";
};

/** Gives every pin in the map that map, so each object's room map is the newest one. */
const storeMaps = (
	familyId: string,
	worldMap: string,
	pins: readonly MapPin[],
	objectIds: ReadonlySet<string>,
) =>
	Promise.all(
		pins
			.filter((pin) => objectIds.has(pin.objectId))
			.map((pin) =>
				apiRequest(SavedPin, pinPath(familyId, pin.objectId), {
					method: "PUT",
					body: { anchorId: pin.anchorId, worldMap },
				}),
			),
	);

type LastCheck = {
	readonly checkId: string;
	readonly picture: string;
	readonly frame: { readonly width: number; readonly height: number };
	readonly capturedAt: string;
	readonly found: ReadonlyMap<string, ObjectDetection>;
};

/** Asks the vision check about the screen's frame; finds the due objects among the detections. */
const check = async (
	familyId: string,
	event: ArEvent & { readonly type: "ar.check" },
	sightings: readonly MedicineSighting[],
): Promise<LastCheck> => {
	const frame = { width: event.width, height: event.height };
	const picture = `data:image/jpeg;base64,${event.image}`;
	const result = await apiRequest(
		ObjectDetections,
		familyPath(familyId, "/vision/object-detections"),
		{
			method: "POST",
			body: detectionRequest(event.checkId, Date.parse(event.capturedAt), {
				...frame,
				picture,
				data: event.image,
			}),
		},
	);
	const found = new Map<string, ObjectDetection>();
	if (result.kind === "ready" && result.value.frame.id === event.checkId)
		// The main object in view comes first, so it wins over a second look-alike.
		for (const detection of result.value.detections) {
			const object = objectFor(detection, sightings);
			if (
				object &&
				event.objectIds.includes(object.id) &&
				!found.has(object.id)
			)
				found.set(object.id, detection);
		}
	return {
		checkId: event.checkId,
		picture,
		frame,
		capturedAt: event.capturedAt,
		found,
	};
};

/** Saves the new sighting of each moved object, then the room map with the moved pins. */
const saveMoved = async (
	familyId: string,
	event: ArEvent & { readonly type: "ar.moved" },
	last: LastCheck,
	{ sightings, change }: ArMember,
) => {
	for (const objectId of event.objectIds) {
		const sighting = sightings.find((s) => s.id === objectId);
		const detection = last.found.get(objectId);
		if (sighting === undefined || detection === undefined) continue;
		const picture = await thumbnail(last, detection.box).catch(() => undefined);
		const seen: RememberMedicine = {
			container: sighting.container,
			place: movedPlace(sighting.place),
			seenAt: last.capturedAt,
			source: "camera_check",
			confidence: detection.confidence,
			labelRead: detection.label !== null,
			category: sighting.category,
			...(picture === undefined ? {} : { thumbnail: picture }),
		};
		await change("POST", "/sightings", seen);
	}
	if (event.worldMap !== undefined)
		await storeMaps(
			familyId,
			event.worldMap,
			event.anchors ?? [],
			new Set(sightings.map((s) => s.id)),
		);
};

/**
 * Reads the AR screen's messages until it closes: checks each camera frame it sends with the
 * family's vision check, and saves the objects it moved. A failed check or save keeps the old
 * place; the screen asks again after 10 s.
 */
const follow = async (familyId: string, session: string, member: ArMember) => {
	let last: LastCheck | null = null;
	let answer: CheckAnswer | undefined;
	for (;;) {
		const event = await watchAr(session, answer);
		answer = undefined;
		if (event === null) return;
		if (event.type === "ar.check") {
			last = await check(familyId, event, member.sightings);
			answer = {
				checkId: event.checkId,
				found: [...last.found].map(([objectId, { box }]) => ({
					objectId,
					x: box.x + box.width / 2,
					y: box.y + box.height / 2,
				})),
			};
		} else if (last?.checkId === event.checkId) {
			await saveMoved(familyId, event, last, member);
		}
	}
};

/**
 * The room map to add a new pin to: the newest pinned thing at the same place, or else the
 * newest pinned thing. When it is another room, the AR screen starts a new map after 20 s.
 */
const roomMap = async (
	familyId: string,
	sighting: MedicineSighting,
	sightings: readonly MedicineSighting[],
) => {
	const pinned = sightings.filter((s) => s.pinned && s.id !== sighting.id);
	const base =
		pinned.find(
			(s) =>
				s.place.trim().toLowerCase() === sighting.place.trim().toLowerCase(),
		) ?? pinned[0];
	if (base === undefined) return undefined;
	const stored = await apiRequest(StoredPin, pinPath(familyId, base.id));
	return stored.kind === "ready" ? stored.value.worldMap : undefined;
};

/** Opens AR to pin the object, then stores the anchor and world map on the server. */
export const pinInAr = async (
	familyId: string,
	sighting: MedicineSighting,
	member: ArMember,
): Promise<ArOutcome> => {
	const worldMap = await roomMap(familyId, sighting, member.sightings);
	const others = othersOf(member.sightings, sighting.id);
	const session = crypto.randomUUID();
	const saving = savePin({
		familyId,
		objectId: sighting.id,
		label: sighting.container,
		session,
		others,
		...(worldMap === undefined ? {} : { worldMap }),
	});
	void follow(familyId, session, member);
	const pin = await saving;
	if (pin.kind === "error") return arFailed(pin, "pin");
	const stored = await apiRequest(SavedPin, pinPath(familyId, sighting.id), {
		method: "PUT",
		body: { anchorId: pin.anchorId, worldMap: pin.worldMap },
	});
	if (stored.kind !== "ready")
		return apiFailed(stored, "I could not save the AR pin");
	// The other pins keep their older map when this fails; they still show on their own.
	await storeMaps(
		familyId,
		pin.worldMap,
		pin.anchors,
		new Set(others.map((o) => o.objectId)),
	);
	return {
		kind: "done",
		text: `Pinned ${sighting.container} in AR. Tap “Show me in AR” to find this spot later.`,
	};
};

/** Reads the stored pin, then opens AR to relocalize and show the marker at it. */
export const showInAr = async (
	familyId: string,
	sighting: MedicineSighting,
	member: ArMember,
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
	const session = crypto.randomUUID();
	const finding = findPin({
		objectId: sighting.id,
		label: sighting.container,
		anchorId: stored.value.anchorId,
		worldMap: stored.value.worldMap,
		session,
		others: othersOf(member.sightings, sighting.id),
	});
	void follow(familyId, session, member);
	const found = await finding;
	return found.kind === "found"
		? {
				kind: "done",
				text: `The marker showed where you pinned ${sighting.container}.`,
			}
		: arFailed(found, "find");
};
