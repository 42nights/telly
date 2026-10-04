import {
	type FamilyMessage,
	FamilyMessage as FamilyMessageSchema,
} from "@health/contracts";
import { FamilyMessages } from "@health/contracts/chat";
import { useEffect, useRef, useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { mergeMessages, type Outgoing, queueSend } from "./logic";

const POLL_MS = 5_000;
/** The server returns at most this many messages after a cursor. */
const PAGE = 200;

type ReadState = { readonly kind: "loading" | "ready" } | ApiFailure;

/**
 * The family's messages, caught up with `GET /messages?after=<last id>` every `POLL_MS`, and sends
 * with `POST /messages`. Mount one per family (key by family id): the cursor belongs to one family.
 */
export function useChat(familyId: string) {
	const [messages, setMessages] = useState<FamilyMessage[]>([]);
	const [read, setRead] = useState<ReadState>({ kind: "loading" });
	const [outbox, setOutbox] = useState<Outgoing[]>([]);
	const [refreshKey, setRefreshKey] = useState(0);
	const last = useRef<string | null>(null);
	const outboxRef = useRef(outbox);
	outboxRef.current = outbox;

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

	/** Sends `body`; resolves true once the server stored it. */
	const send = async (body: string): Promise<boolean> => {
		const queued = queueSend(outboxRef.current, body, () =>
			crypto.randomUUID(),
		);
		outboxRef.current = queued.outbox;
		setOutbox(queued.outbox);
		const { clientId } = queued;
		const result = await apiRequest(
			FamilyMessageSchema,
			familyPath(familyId, "/messages"),
			{ method: "POST", body: { clientId, body } },
		);
		const others = outboxRef.current.filter((e) => e.clientId !== clientId);
		if (result.kind === "ready") {
			setMessages((current) => mergeMessages(current, [result.value]));
			outboxRef.current = others;
			setOutbox(others);
			return true;
		}
		console.error("Family message not sent:", result);
		const failed = [...others, { clientId, body, status: "failed" as const }];
		outboxRef.current = failed;
		setOutbox(failed);
		return false;
	};

	return {
		messages,
		read,
		outbox,
		send,
		retryRead: () => setRefreshKey((key) => key + 1),
	};
}
