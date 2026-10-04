// Photon Spectrum Cloud: the only module that loads the iMessage provider. Spectrum Cloud POSTs each
// message to the webhook route, so the agent needs no open stream and works in a container that sleeps.
import type { FamilyAnswer, FamilyQuestion } from "@health/contracts/ask";
import {
	type AnyPlatformDef,
	type Platform,
	Spectrum,
} from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type { IMessageConfig } from "../config";
import { iMessageHandler } from "./agent";

export const startCloudIMessage = async (
	{ projectId, projectSecret, webhookSecret, senders }: IMessageConfig,
	answer: (familyId: bigint, question: FamilyQuestion) => Promise<FamilyAnswer>,
) => {
	const app = await Spectrum({
		projectId,
		projectSecret,
		webhookSecret,
		// The published 12.10.1 types infer iMessage's definition as `never`; the runtime value is a normal platform.
		providers: [(imessage as unknown as Platform<AnyPlatformDef>).config()],
	});
	const handle = iMessageHandler({ senders, answer });
	return {
		stop: () => app.stop(),
		/** Verifies the signature, answers 2xx at once, then replies to the message in the background. */
		webhook: (request: Request) => app.webhook(request, handle),
	};
};
