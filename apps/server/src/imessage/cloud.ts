// Photon Spectrum Cloud: the only module that loads the iMessage provider.
import type { FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import {
	type AnyPlatformDef,
	type Platform,
	Spectrum,
} from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type { IMessageConfig } from "../config";
import { runIMessageAgent } from "./agent";

export const startCloudIMessage = async (
	{ projectId, projectSecret, senders }: IMessageConfig,
	answer: (familyId: bigint, question: FamilyQuestion) => Promise<FamilyAnswer>,
) => {
	const app = await Spectrum({
		projectId,
		projectSecret,
		// The published 12.10.1 types infer iMessage's definition as `never`; the runtime value is a normal platform.
		providers: [(imessage as unknown as Platform<AnyPlatformDef>).config()],
	});
	void runIMessageAgent(app.messages, { senders, answer }).catch((error) =>
		console.error("imessage: agent stopped", error),
	);
	return app;
};
