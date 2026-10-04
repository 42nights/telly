import type { FamilyMessage } from "@health/contracts";
import { FamilyMessages, type SendFamilyMessage } from "@health/contracts/chat";
import { VoiceTranscript } from "@health/contracts/voice";
import { useQuery } from "@tanstack/react-query";

import {
	type ApiFailure,
	ApiReadError,
	apiRequest,
	failureOf,
	familyPath,
	reread,
} from "@/lib/api";
import { type Outcome, submitAction } from "@/lib/pending";
import { apiKey, queryClient, useAccount } from "@/lib/query";

import { mergeMessages } from "./logic";

const POLL_MS = 5_000;
/** The server returns at most this many messages after a cursor. */
const PAGE = 200;

type ReadState = { readonly kind: "loading" | "ready" } | ApiFailure;

/**
 * The family's person-to-person messages, caught up with `GET /messages?after=<newest id>` every
 * `POLL_MS` and right after a send. The messages stay cached per family, so a return to the chat
 * shows them at once and reads only the newer ones.
 */
export function useChat(familyId: string) {
	const path = familyPath(familyId, "/messages");
	useAccount();
	const queryKey = apiKey(path);
	const query = useQuery(
		{
			queryKey,
			queryFn: async ({ signal }) => {
				let messages =
					queryClient.getQueryData<FamilyMessage[]>(queryKey) ?? [];
				for (;;) {
					const newest = messages.at(-1);
					const result = await apiRequest(
						FamilyMessages,
						newest === undefined ? path : `${path}?after=${newest.id}`,
						{ signal },
					);
					if (result.kind !== "ready") throw new ApiReadError(result);
					messages = mergeMessages(messages, result.value.messages);
					if (result.value.messages.length < PAGE) return messages;
				}
			},
			staleTime: POLL_MS,
			refetchInterval: POLL_MS,
			refetchOnWindowFocus: true,
		},
		queryClient,
	);
	const read: ReadState =
		query.status === "pending"
			? { kind: "loading" }
			: query.status === "error"
				? failureOf(query.error)
				: { kind: "ready" };

	/**
	 * Sends `body` to the family through the device's pending queue, so a lost reply, a reload, or a
	 * restart stores it once. A stored message reads the chat again (`invalidateAfterWrite`).
	 */
	const send = async (body: string): Promise<Outcome> => {
		const payload: Omit<SendFamilyMessage, "clientId"> = { body };
		const outcome = await submitAction(path, payload);
		if (outcome.kind !== "sent")
			console.error("Family message not stored yet:", outcome);
		return outcome;
	};

	/** Turns a recording into text with `POST /voice/transcriptions`. */
	const transcribe = (audio: Blob) =>
		apiRequest(VoiceTranscript, familyPath(familyId, "/voice/transcriptions"), {
			method: "POST",
			rawBody: { data: audio, type: audio.type },
		});

	return {
		messages: query.data ?? [],
		read,
		refresh: () => void reread(path),
		send,
		transcribe,
	};
}
