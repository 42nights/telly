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
import type { WearerActions } from "./finder";

// The published 12.10.1 types infer iMessage's definition as `never`; the runtime value is a normal platform.
const provider = imessage as unknown as Platform<AnyPlatformDef>;

export const startCloudIMessage = async (
	{ projectId, projectSecret, webhookSecret, senders }: IMessageConfig,
	answer: (familyId: bigint, question: FamilyQuestion) => Promise<FamilyAnswer>,
	wearer: WearerActions | undefined,
) => {
	const app = await Spectrum({
		projectId,
		projectSecret,
		webhookSecret,
		providers: [provider.config()],
	});
	const handle = iMessageHandler({ senders, answer, wearer });
	return {
		stop: () => app.stop(),
		/** Verifies the signature, answers 2xx at once, then replies to the message in the background. */
		webhook: (request: Request) => app.webhook(request, handle),
		/** Starts or reuses the 1:1 conversation with `address` (E.164 phone or email) and sends `body`. */
		text: async (address: string, body: string) => {
			const space = await provider(app).space.create(address);
			await space.send(body);
		},
	};
};
