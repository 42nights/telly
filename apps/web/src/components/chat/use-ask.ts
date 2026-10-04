import {
	FamilyAnswer,
	type FamilyQuestion,
	type QuestionAttachment,
	VoiceAnswer,
} from "@health/contracts/ask";
import { useState } from "react";

import { type ApiResult, apiRequest, familyPath } from "@/lib/api";
import { play } from "@/lib/player";

import {
	type Ask,
	failureText,
	type GeminiStatus,
	nextGeminiStatus,
} from "./logic";

/**
 * Questions to Gemini with `POST /ask` and `POST /ask/voice`. There is no answer history route, so
 * the asks live only in this session. Speech plays only when the reply carries audio.
 */
export function useAsk(familyId: string) {
	const [asks, setAsks] = useState<Ask[]>([]);
	const [status, setStatus] = useState<GeminiStatus>({ kind: "unknown" });

	const update = (id: string, change: Partial<Ask>) =>
		setAsks((current) =>
			current.map((ask) => (ask.id === id ? { ...ask, ...change } : ask)),
		);

	const start = (question: string, files: readonly string[]) => {
		const id = crypto.randomUUID();
		setAsks((current) => [
			...current,
			{
				id,
				question,
				files,
				askedAt: new Date().toISOString(),
				state: { kind: "pending" },
			},
		]);
		return id;
	};

	/** Records the outcome; true when Gemini answered. */
	const settle = (id: string, result: ApiResult<unknown>) => {
		setStatus((current) => nextGeminiStatus(current, result));
		if (result.kind === "ready") return true;
		console.error("Gemini did not answer:", result);
		update(id, { state: { kind: "failed", message: failureText(result) } });
		return false;
	};

	/** Asks `question` with the attached files; resolves true once Gemini answered. */
	const ask = async (
		question: string,
		attachments: readonly QuestionAttachment[],
	): Promise<boolean> => {
		const id = start(
			question,
			attachments.map((file) => file.name),
		);
		const body: FamilyQuestion = {
			question,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...(attachments.length > 0 ? { attachments } : {}),
		};
		const result = await apiRequest(
			FamilyAnswer,
			familyPath(familyId, "/ask"),
			{ method: "POST", body },
		);
		if (!settle(id, result) || result.kind !== "ready") return false;
		update(id, { state: { kind: "answered", answer: result.value } });
		return true;
	};

	/** Asks with a recording. Returns a message when no speech plays, otherwise null. */
	const askVoice = async (audio: Blob): Promise<string | null> => {
		const id = start("Voice question", []);
		const zone = encodeURIComponent(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
		);
		const result = await apiRequest(
			VoiceAnswer,
			`${familyPath(familyId, "/ask/voice")}?timeZone=${zone}`,
			{ method: "POST", rawBody: { data: audio, type: audio.type } },
		);
		if (!settle(id, result) || result.kind !== "ready") return null;
		const { transcript, answer, speech } = result.value;
		update(id, {
			question: transcript.text,
			state: { kind: "answered", answer },
		});
		if (speech.status !== "ok") return `No spoken answer: ${speech.message}`;
		await play(`data:audio/mpeg;base64,${speech.audio}`).catch((error) =>
			console.error("Spoken answer did not play:", error),
		);
		return null;
	};

	return { asks, status, ask, askVoice };
}
