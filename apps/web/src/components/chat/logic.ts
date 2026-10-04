import type { FamilyMessage } from "@health/contracts";
import type { FamilyAnswer } from "@health/contracts/ask";
import type { Evidence } from "@health/contracts/chat";

import type { ApiResult } from "@/lib/api";

/** Splits picked items into real files with data and everything else (rejected). */
export function acceptFiles(items: Iterable<unknown>): {
	accepted: File[];
	rejected: unknown[];
} {
	const accepted: File[] = [];
	const rejected: unknown[] = [];
	for (const item of items) {
		if (item instanceof File && item.size > 0) accepted.push(item);
		else rejected.push(item);
	}
	return { accepted, rejected };
}

/** `512 B`, `1.5 KB`, `12 MB`: one decimal below 10, whole numbers above. */
export function formatSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const shown =
		unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${shown} ${units[unit]}`;
}

/** A question asked in this session. Answers have no history route, so they live only here. */
export type Ask = {
	readonly id: string;
	readonly question: string;
	/** Client time when asked, ISO. */
	readonly askedAt: string;
	readonly state:
		| { readonly kind: "pending" }
		| { readonly kind: "answered"; readonly answer: FamilyAnswer }
		| { readonly kind: "failed"; readonly message: string };
};

/** What the header may claim about Gemini: only what this session has seen. */
export type GeminiStatus =
	| { readonly kind: "unknown" }
	| { readonly kind: "ready" }
	| { readonly kind: "unavailable"; readonly message: string };

/** A success proves Gemini ready; a 503 proves it unavailable; other failures prove nothing. */
export function nextGeminiStatus(
	current: GeminiStatus,
	result: ApiResult<unknown>,
): GeminiStatus {
	if (result.kind === "ready") return { kind: "ready" };
	if (result.kind === "unavailable")
		return { kind: "unavailable", message: result.message };
	return current;
}

export const GEMINI_CHIP: Record<GeminiStatus["kind"], string> = {
	unknown: "Gemini",
	ready: "Gemini · ready",
	unavailable: "Gemini · unavailable",
};

/** One compact source line: metric, value and unit, source, source time, and stale. */
export function evidenceLine(
	evidence: Evidence,
	formatTime: (iso: string) => string,
): string {
	const parts = [
		`${evidence.metric} ${evidence.value} ${evidence.unit}`,
		evidence.source,
		formatTime(evidence.sourceTime),
	];
	if (evidence.stale) parts.push("stale");
	return parts.join(" · ");
}

export type TimelineItem =
	| {
			readonly kind: "message";
			readonly at: string;
			readonly message: FamilyMessage;
	  }
	| { readonly kind: "ask"; readonly at: string; readonly ask: Ask };

/** Family messages and this session's asks in time order (stable for equal times). */
export function timeline(
	messages: readonly FamilyMessage[],
	asks: readonly Ask[],
): TimelineItem[] {
	const items: TimelineItem[] = [
		...messages.map((message) => ({
			kind: "message" as const,
			at: message.sentAt,
			message,
		})),
		...asks.map((ask) => ({ kind: "ask" as const, at: ask.askedAt, ask })),
	];
	return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Adds `incoming` to `current` once per id, ordered by the numeric database id. */
export function mergeMessages(
	current: readonly FamilyMessage[],
	incoming: readonly FamilyMessage[],
): FamilyMessage[] {
	const byId = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) byId.set(message.id, message);
	return [...byId.values()].sort((a, b) => {
		const d = BigInt(a.id) - BigInt(b.id);
		return d < 0n ? -1 : d > 0n ? 1 : 0;
	});
}

/** A message this device sent that the server has not stored yet. */
export type Outgoing = {
	readonly clientId: string;
	readonly body: string;
	readonly status: "sending" | "failed";
};

/**
 * Starts a send. A failed message with the same body is retried with its own `clientId`, so the
 * server stores it once; any other body gets a new id from `makeId`.
 */
export function queueSend(
	outbox: readonly Outgoing[],
	body: string,
	makeId: () => string,
): { outbox: Outgoing[]; clientId: string } {
	const failed = outbox.find(
		(entry) => entry.status === "failed" && entry.body === body,
	);
	const clientId = failed?.clientId ?? makeId();
	const entry: Outgoing = { clientId, body, status: "sending" };
	return {
		outbox: failed
			? outbox.map((e) => (e.clientId === clientId ? entry : e))
			: [...outbox, entry],
		clientId,
	};
}
