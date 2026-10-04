// The AR pin requests from the web app (contract: telly-ar-pin) and their answers. The shell
// (app/(drawer)/web.tsx) decodes a request, calls `answerArRequest`, and sends the answer back as
// a "telly-ar" event. The native module answers without `requestId`; this adds it. `objectId` is the
// remembered object's sighting id (#301); the web app also sends it as `containerId` for shells
// built before #301, so the pin's anchor name `telly-pin-<id>` is the same either way.
// Since #351 the screen follows the member's other pinned objects (`others`), a save can join the
// member's room map (`worldMap`), and `ar.watch` reads the open screen's messages for `session`.
// Web apps from before #351 send none of these, so each is optional.
import { Schema } from "effect";

import type { ArEvent, MapPin, TellyArModule } from "@/modules/telly-ar";

const PinnedObject = Schema.Struct({
	objectId: Schema.String,
	label: Schema.String,
});
const Others = Schema.optionalKey(Schema.Array(PinnedObject));
const Session = Schema.optionalKey(Schema.String);

export const ArRequest = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("ar.capabilities"),
		requestId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("ar.savePin"),
		requestId: Schema.String,
		familyId: Schema.String,
		objectId: Schema.String,
		label: Schema.String,
		session: Session,
		others: Others,
		worldMap: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("ar.findPin"),
		requestId: Schema.String,
		objectId: Schema.String,
		label: Schema.String,
		anchorId: Schema.String,
		worldMap: Schema.String,
		session: Session,
		others: Others,
	}),
	Schema.Struct({
		type: Schema.Literal("ar.watch"),
		requestId: Schema.String,
		session: Schema.String,
		answer: Schema.optionalKey(
			Schema.Struct({
				checkId: Schema.String,
				found: Schema.Array(
					Schema.Struct({
						objectId: Schema.String,
						x: Schema.Finite,
						y: Schema.Finite,
					}),
				),
			}),
		),
	}),
]);
export type ArRequest = typeof ArRequest.Type;

export type ArReply =
	| {
			type: "ar.capabilities";
			requestId: string;
			supported: boolean;
			reason?: "no-arkit" | "no-camera-permission" | "not-ios";
	  }
	| {
			type: "ar.pinSaved";
			requestId: string;
			objectId: string;
			anchorId: string;
			worldMap: string;
			mapBytes: number;
			anchors: MapPin[];
	  }
	| { type: "ar.pinFound"; requestId: string; objectId: string }
	| (ArEvent & { requestId: string })
	| { type: "ar.error"; requestId: string; code: string; message: string };

type PinRequest = Extract<ArRequest, { type: "ar.savePin" | "ar.findPin" }>;

/** Opens the AR screen for a save or a find. The optional fields are missing from web apps before #351. */
const openPin = (request: PinRequest, native: TellyArModule) => {
	const session = request.session ?? null;
	const others = [...(request.others ?? [])];
	return request.type === "ar.savePin"
		? native.savePin(
				request.objectId,
				request.label,
				session,
				others,
				request.worldMap ?? null,
			)
		: native.findPin(
				request.objectId,
				request.label,
				request.anchorId,
				request.worldMap,
				session,
				others,
			);
};

// `native` is null where the module is not built in; `os` is `Platform.OS`.
export const answerArRequest = async (
	request: ArRequest,
	native: TellyArModule | null,
	os: string,
): Promise<ArReply> => {
	const { requestId } = request;
	if (request.type === "ar.capabilities") {
		if (native === null)
			return {
				type: "ar.capabilities",
				requestId,
				supported: false,
				reason: os === "ios" ? "no-arkit" : "not-ios",
			};
		return {
			type: "ar.capabilities",
			requestId,
			...(await native.capabilities()),
		};
	}
	if (native === null)
		return {
			type: "ar.error",
			requestId,
			code: "failed",
			message: "AR is not available in this app.",
		};
	try {
		if (request.type === "ar.watch") {
			const event = await native.watch(
				request.session,
				request.answer === undefined
					? null
					: { ...request.answer, found: [...request.answer.found] },
			);
			return { ...event, requestId };
		}
		const answer = await openPin(request, native);
		return answer.type === "ar.error"
			? { ...answer, requestId }
			: { ...answer, requestId, objectId: request.objectId };
	} catch (error) {
		return {
			type: "ar.error",
			requestId,
			code: "failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
};
