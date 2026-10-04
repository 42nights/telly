// Care actions that wait for the server, saved on this device (issue #45). A reload, a restart, or
// a lost connection neither drops nor repeats them: each action gets one `clientId` when it is
// queued and keeps it on every resend, and the server stores a resend with the same `clientId` once.
// Queue only routes that dedupe by `clientId` (family messages: `send_message`; reminders: #28).
import { tokenClaims } from "@health/contracts/session";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import { apiRequest } from "./api";
import { getSessionToken, onSessionChange } from "./session";

const KEY = "telly.pending";
const RETRY_MS = 15_000;

const PendingAction = Schema.Struct({
	clientId: Schema.String,
	/** The signed-in identity that queued the action. Only that identity sends it. */
	owner: Schema.String,
	path: Schema.String,
	/** The POST body without `clientId`. */
	payload: Schema.Record(Schema.String, Schema.Unknown),
	queuedAt: Schema.Number,
});
type PendingAction = typeof PendingAction.Type;

const decodeQueue = Schema.decodeUnknownOption(Schema.Array(PendingAction));
const decodeOwner = Schema.decodeUnknownOption(
	Schema.Struct({ iss: Schema.String, sub: Schema.String }),
);

export type Outcome =
	| { readonly kind: "sent" }
	/** Saved on this device; it is sent once when the server can be reached and the owner is signed in. */
	| { readonly kind: "waiting" }
	/** The server refused it; it is not resent. */
	| { readonly kind: "rejected"; readonly message: string };

const listeners = new Set<() => void>();

const load = (): PendingAction[] => {
	try {
		const saved = decodeQueue(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
		return saved._tag === "Some" ? [...saved.value] : [];
	} catch {
		return [];
	}
};

const save = (queue: readonly PendingAction[]) => {
	if (queue.length === 0) localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, JSON.stringify(queue));
	for (const listener of listeners) listener();
};

const currentOwner = (): string | null => {
	const token = getSessionToken();
	if (token === null) return null;
	const claims = decodeOwner(tokenClaims(token));
	return claims._tag === "Some"
		? `${claims.value.iss} ${claims.value.sub}`
		: null;
};

const send = async (action: PendingAction): Promise<Outcome> => {
	const result = await apiRequest(null, action.path, {
		method: "POST",
		body: { ...action.payload, clientId: action.clientId },
	});
	if (result.kind === "ready") return { kind: "sent" };
	if (
		result.kind === "signed_out" ||
		result.kind === "unavailable" ||
		(result.kind === "error" && result.unreachable === true)
	)
		return { kind: "waiting" };
	return { kind: "rejected", message: result.message };
};

/** Sends the signed-in owner's actions in queue order, and stops at the first one that must wait. */
const run = async (): Promise<Map<string, Outcome>> => {
	const outcomes = new Map<string, Outcome>();
	const owner = currentOwner();
	if (owner === null) return outcomes;
	for (const action of load()) {
		if (action.owner !== owner) continue;
		const outcome = await send(action);
		outcomes.set(action.clientId, outcome);
		if (outcome.kind === "waiting") break;
		if (outcome.kind === "rejected")
			console.error("A saved action was refused and is not resent:", {
				path: action.path,
				message: outcome.message,
			});
		save(load().filter((saved) => saved.clientId !== action.clientId));
	}
	return outcomes;
};

let running: Promise<Map<string, Outcome>> | null = null;

/** Sends the waiting actions. One pass runs at a time, so this device never sends an action twice at once. */
export const flushPending = async (): Promise<Map<string, Outcome>> => {
	while (running !== null) await running;
	running = run();
	try {
		return await running;
	} finally {
		running = null;
	}
};

/**
 * Saves a POST of `payload` to `path`, then sends it. A resend of the same payload while the first
 * still waits reuses the saved action and its `clientId`, so a repeated tap stores one action.
 */
export const submitAction = async (
	path: string,
	payload: Record<string, unknown>,
): Promise<Outcome> => {
	const owner = currentOwner();
	if (owner === null) return { kind: "rejected", message: "Sign in first." };
	const queue = load();
	const json = JSON.stringify(payload);
	let action = queue.find(
		(saved) =>
			saved.owner === owner &&
			saved.path === path &&
			JSON.stringify(saved.payload) === json,
	);
	if (action === undefined) {
		action = {
			clientId: crypto.randomUUID(),
			owner,
			path,
			payload,
			queuedAt: Date.now(),
		};
		save([...queue, action]);
	}
	const outcomes = await flushPending();
	return outcomes.get(action.clientId) ?? { kind: "waiting" };
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const ownCount = () => {
	const owner = currentOwner();
	return load().filter((action) => action.owner === owner).length;
};

/** How many of the signed-in person's actions wait on this device. */
export const usePendingCount = (): number =>
	useSyncExternalStore(subscribe, ownCount, () => 0);

/** Resends waiting actions now, and again on reconnect, on sign-in, and every `RETRY_MS`. Call once. */
export const startPendingSync = () => {
	const flush = () => void flushPending();
	flush();
	window.addEventListener("online", flush);
	// Another tab changed the queue: show the new count.
	window.addEventListener("storage", (event) => {
		if (event.key === KEY) for (const listener of listeners) listener();
	});
	onSessionChange(() => {
		for (const listener of listeners) listener();
		flush();
	});
	setInterval(() => {
		if (ownCount() > 0) flush();
	}, RETRY_MS);
};
