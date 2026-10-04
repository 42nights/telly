import type { FamilyMessage } from "@health/contracts";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENTS_MAX_TOTAL_BYTES,
	type FamilyAnswer,
	QuestionAttachment,
} from "@health/contracts/ask";
import type { Evidence } from "@health/contracts/chat";
import { Schema } from "effect";

import type { ApiFailure, ApiResult } from "@/lib/api";

/** `FamilyQuestion` accepts at most this many files. */
const MAX_FILES = 4;
const mimeType = QuestionAttachment.fields.mimeType;
const isAttachmentType = Schema.is(mimeType);
/** `text/plain;charset=utf-8` → `text/plain`. */
const baseType = (file: File) =>
	file.type.split(";")[0]?.trim().toLowerCase() ?? "";

/** The file types the family agent reads, for the file picker's `accept`. */
export const ATTACHMENT_ACCEPT = mimeType.literals.join(",");

/** A file in the composer tray. `error` says why it cannot go with the question; null when it can. */
export type Attached = {
	readonly id: string;
	readonly file: File;
	readonly error: string | null;
};

function attachmentError(file: File, accepted: readonly File[]): string | null {
	if (!isAttachmentType(baseType(file))) return "Type not supported";
	if (file.size === 0) return "Empty file";
	if (file.size > ATTACHMENT_MAX_BYTES)
		return `Over ${formatSize(ATTACHMENT_MAX_BYTES)}`;
	if (accepted.length >= MAX_FILES) return `Over ${MAX_FILES} files`;
	const total = accepted.reduce((sum, other) => sum + other.size, file.size);
	if (total > ATTACHMENTS_MAX_TOTAL_BYTES)
		return `Over ${formatSize(ATTACHMENTS_MAX_TOTAL_BYTES)} in total`;
	return null;
}

/** Adds picked files to the tray. A file over the contract limits stays visible with its reason. */
export function attachFiles(
	current: readonly Attached[],
	picked: Iterable<File>,
): Attached[] {
	const next = [...current];
	for (const file of picked) {
		const accepted = next.flatMap((entry) =>
			entry.error === null ? [entry.file] : [],
		);
		next.push({
			id: crypto.randomUUID(),
			file,
			error: attachmentError(file, accepted),
		});
	}
	return next;
}

/** Reads a file into the base64 attachment that `POST /ask` takes. */
export async function toAttachment(file: File): Promise<QuestionAttachment> {
	const type = baseType(file);
	if (!isAttachmentType(type))
		throw new Error(`${file.name}: type ${type} is not supported`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return { name: file.name.slice(0, 200), mimeType: type, data: btoa(binary) };
}

/** The family message being sent. A resend of the same text keeps its clientId, so it is stored once. */
export type Outbox = { readonly body: string; readonly clientId: string };

export const outboxFor = (previous: Outbox | null, body: string): Outbox =>
	previous?.body === body ? previous : { body, clientId: crypto.randomUUID() };

/** The text to show for a failed request. */
export const failureText = (failure: ApiFailure): string =>
	failure.kind === "signed_out" ? "Sign in first." : failure.message;

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
	/** Names of the files sent with the question. */
	readonly files: readonly string[];
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
