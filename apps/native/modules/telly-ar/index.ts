// The TellyAr native module (ios/TellyArModule.swift). It is null where it is not built in:
// Android, web, and Expo Go.
import { requireOptionalNativeModule } from "expo";

export type ArErrorAnswer = {
	type: "ar.error";
	code: string;
	message: string;
};

export type TellyArModule = {
	capabilities(): Promise<{
		supported: boolean;
		reason?: "no-arkit" | "no-camera-permission";
	}>;
	savePin(
		containerId: string,
		label: string,
	): Promise<
		| {
				type: "ar.pinSaved";
				anchorId: string;
				worldMap: string;
				mapBytes: number;
		  }
		| ArErrorAnswer
	>;
	findPin(
		containerId: string,
		label: string,
		anchorId: string,
		worldMap: string,
	): Promise<{ type: "ar.pinFound" } | ArErrorAnswer>;
};

export default requireOptionalNativeModule<TellyArModule>("TellyAr");
