import type { FamilyMessage } from "@health/contracts";
import { FamilyMessages, type SendFamilyMessage } from "@health/contracts/chat";
import { VoiceTranscript } from "@health/contracts/voice";
import { useEffect, useRef, useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { failureText, mergeMessages, type Outbox, outboxFor } from "./logic";

const POLL_MS = 5_000;
/** The server returns at most this many messages after a cursor. */
const PAGE = 200;

type ReadState = { readonly kind: "loading" | "ready" } | ApiFailure;

/**
 * The family's person-to-person messages, caught up with `GET /messages?after=<last id>` every
 * `POLL_MS` and right after a send. Mount one per family (key by family id): the cursor belongs to
 * one family.
 */
export function useChat(familyId: string) {
	const [messages, setMessages] = useState<FamilyMessage[]>([]);
	const [read, setRead] = useState<ReadState>({ kind: "loading" });
	const [refreshKey, setRefreshKey] = useState(0);
	const last = useRef<string | null>(null);
	const outbox = useRef<Outbox | null>(null);

	useEffect(() => {
		void refreshKey;
		const controller = new AbortController();
		let busy = false;
		const catchUp = async () => {
			if (busy) return;
			busy = true;
			try {
				for (;;) {
					const after = last.current === null ? "" : `?after=${last.current}`;
					const result = await apiRequest(
						FamilyMessages,
						familyPath(familyId, `/messages${after}`),
						{ signal: controller.signal },
					);
					if (result.kind !== "ready") {
						setRead(result);
						return;
					}
					const page = result.value.messages;
					const newest = page.at(-1);
					if (newest !== undefined) last.current = newest.id;
					setMessages((current) => mergeMessages(current, page));
					setRead({ kind: "ready" });
					if (page.length < PAGE) return;
				}
			} catch {
				// Aborted on unmount.
			} finally {
				busy = false;
			}
		};
		void catchUp();
		const timer = setInterval(catchUp, POLL_MS);
		return () => {
			clearInterval(timer);
			controller.abort();
		};
	}, [familyId, refreshKey]);

	const refresh = () => setRefreshKey((key) => key + 1);

	/** Sends `body` to the family. Resolves null once stored, otherwise why it was not sent. */
	const send = async (body: string): Promise<string | null> => {
		const message: SendFamilyMessage = outboxFor(outbox.current, body);
		outbox.current = message;
		const result = await apiRequest(null, familyPath(familyId, "/messages"), {
			method: "POST",
			body: message,
		});
		if (result.kind !== "ready") {
			console.error("Family message not sent:", result);
			return failureText(result);
		}
		outbox.current = null;
		refresh();
		return null;
	};

	/** Turns a recording into text with `POST /voice/transcriptions`. */
	const transcribe = (audio: Blob) =>
		apiRequest(VoiceTranscript, familyPath(familyId, "/voice/transcriptions"), {
			method: "POST",
			rawBody: { data: audio, type: audio.type },
		});

	return { messages, read, refresh, send, transcribe };
}
