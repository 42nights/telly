// The AR pin requests from the web app (contract: telly-ar-pin) and their answers. The shell
// (app/(drawer)/web.tsx) decodes a request, calls `answerArRequest`, and sends the answer back as
// a "telly-ar" event. The native module answers without `requestId`; this adds it.
import { Schema } from "effect";

import type { TellyArModule } from "@/modules/telly-ar";

export const ArRequest = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("ar.capabilities"),
		requestId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("ar.savePin"),
		requestId: Schema.String,
		familyId: Schema.String,
		containerId: Schema.String,
		label: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("ar.findPin"),
		requestId: Schema.String,
		containerId: Schema.String,
		label: Schema.String,
		anchorId: Schema.String,
		worldMap: Schema.String,
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
			containerId: string;
			anchorId: string;
			worldMap: string;
			mapBytes: number;
	  }
	| { type: "ar.pinFound"; requestId: string; containerId: string }
	| { type: "ar.error"; requestId: string; code: string; message: string };

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
		const answer =
			request.type === "ar.savePin"
				? await native.savePin(request.containerId, request.label)
				: await native.findPin(
						request.containerId,
						request.label,
						request.anchorId,
						request.worldMap,
					);
		return answer.type === "ar.error"
			? { ...answer, requestId }
			: { ...answer, requestId, containerId: request.containerId };
	} catch (error) {
		return {
			type: "ar.error",
			requestId,
			code: "failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
};
