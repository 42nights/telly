import type { FamilyMessage } from "@health/contracts";
import { FamilyMessages } from "@health/contracts/chat";
import { useEffect, useRef, useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { mergeMessages } from "./logic";

const POLL_MS = 5_000;
/** The server returns at most this many messages after a cursor. */
const PAGE = 200;

type ReadState = { readonly kind: "loading" | "ready" } | ApiFailure;

/**
 * The family's person-to-person messages, read-only, caught up with `GET /messages?after=<last id>`
 * every `POLL_MS`. Mount one per family (key by family id): the cursor belongs to one family.
 */
export function useChat(familyId: string) {
	const [messages, setMessages] = useState<FamilyMessage[]>([]);
	const [read, setRead] = useState<ReadState>({ kind: "loading" });
	const [refreshKey, setRefreshKey] = useState(0);
	const last = useRef<string | null>(null);

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

	return {
		messages,
		read,
		retryRead: () => setRefreshKey((key) => key + 1),
	};
}
