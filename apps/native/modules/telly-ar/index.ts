// The TellyAr native module (ios/TellyArModule.swift). It is null where it is not built in:
// Android, web, and Expo Go.
import { requireOptionalNativeModule } from "expo";

export type ArErrorAnswer = {
	type: "ar.error";
	code: string;
	message: string;
};

/** Another pinned object of the member, followed while the AR screen runs (#351). */
export type PinnedObject = { objectId: string; label: string };

/** A pin in a saved room map. */
export type MapPin = { objectId: string; anchorId: string };

/** The web app's answer to an `ar.check`: the box centers it confirmed, in the sent picture's pixels. */
export type CheckAnswer = {
	checkId: string;
	found: { objectId: string; x: number; y: number }[];
};

/** A message of the open AR screen to the web app, or `ar.closed` once it closed. */
export type ArEvent =
	| {
			type: "ar.check";
			checkId: string;
			objectIds: string[];
			/** Base64 JPEG of the phone's camera frame, upright. */
			image: string;
			width: number;
			height: number;
			capturedAt: string;
	  }
	| {
			type: "ar.moved";
			checkId: string;
			objectIds: string[];
			/** The room map with the moved anchors; missing when it could not be saved. */
			worldMap?: string;
			anchors?: MapPin[];
	  }
	| { type: "ar.closed" };

export type TellyArModule = {
	capabilities(): Promise<{
		supported: boolean;
		reason?: "no-arkit" | "no-camera-permission";
	}>;
	savePin(
		objectId: string,
		label: string,
		session: string | null,
		others: PinnedObject[],
		worldMap: string | null,
	): Promise<
		| {
				type: "ar.pinSaved";
				anchorId: string;
				worldMap: string;
				mapBytes: number;
				anchors: MapPin[];
		  }
		| ArErrorAnswer
	>;
	findPin(
		objectId: string,
		label: string,
		anchorId: string,
		worldMap: string,
		session: string | null,
		others: PinnedObject[],
	): Promise<{ type: "ar.pinFound" } | ArErrorAnswer>;
	watch(session: string, answer: CheckAnswer | null): Promise<ArEvent>;
};

export default requireOptionalNativeModule<TellyArModule>("TellyAr");
