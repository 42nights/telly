import { useEffect, useRef, useState } from "react";

import { type ApiResult, apiBlob, familyPath } from "@/lib/api";

export type Speech =
	/** `key` is the text spoken last, so its button can offer "Say it again". */
	| { readonly kind: "idle"; readonly key: string | null }
	| { readonly kind: "loading"; readonly key: string }
	| { readonly kind: "speaking"; readonly key: string }
	| { readonly kind: "failed"; readonly key: string; readonly message: string };

const failureText = {
	signed_out: "Sign in to hear this read aloud.",
	forbidden: "You can't use the voice for this person.",
	unavailable: "The voice is not available right now.",
	error: "I couldn't read this aloud.",
} as const;

/** The audio URL to play: the given MP3, or speech for `text` from `POST /voice/speech`. */
const audioUrl = async (
	familyId: string | null,
	text: string,
	mp3Base64: string | undefined,
	signal: AbortSignal,
): Promise<ApiResult<string>> => {
	if (mp3Base64 !== undefined)
		return { kind: "ready", value: `data:audio/mpeg;base64,${mp3Base64}` };
	if (familyId === null) return { kind: "signed_out" };
	const result = await apiBlob(familyPath(familyId, "/voice/speech"), {
		body: { text: text.slice(0, 2000) },
		signal,
	});
	return result.kind === "ready"
		? { kind: "ready", value: URL.createObjectURL(result.value) }
		: result;
};

/**
 * Reads real text aloud, one text at a time: the MP3 that came with it when given, otherwise
 * ElevenLabs speech from `POST /voice/speech`. `key` names what is spoken, so each button can show
 * its own state.
 */
export function useSpeech(familyId: string | null) {
	const [speech, setSpeech] = useState<Speech>({ kind: "idle", key: null });
	const current = useRef<{ stop: () => void } | null>(null);
	useEffect(() => () => current.current?.stop(), []);

	const say = async (key: string, text: string, mp3Base64?: string) => {
		current.current?.stop();
		const controller = new AbortController();
		let audio: HTMLAudioElement | null = null;
		let url = "";
		const stop = () => {
			controller.abort();
			audio?.pause();
			if (url.startsWith("blob:")) URL.revokeObjectURL(url);
		};
		current.current = { stop };
		setSpeech({ kind: "loading", key });
		const result = await audioUrl(
			familyId,
			text,
			mp3Base64,
			controller.signal,
		).catch(() => null);
		if (result === null || controller.signal.aborted) return;
		if (result.kind !== "ready") {
			setSpeech({ kind: "failed", key, message: failureText[result.kind] });
			return;
		}
		url = result.value;
		audio = new Audio(url);
		audio.onended = () => {
			stop();
			setSpeech({ kind: "idle", key });
		};
		setSpeech({ kind: "speaking", key });
		await audio.play().catch(() => {
			if (controller.signal.aborted) return;
			stop();
			setSpeech({
				kind: "failed",
				key,
				message: "The browser blocked the sound. Press the button again.",
			});
		});
	};

	return { speech, say };
}

const speechText = {
	loading: "Getting the voice…",
	speaking: "Speaking…",
} as const;

/** The spoken status of one text; nothing while idle. */
export function SpeechLine({ speech }: { speech: Speech }) {
	if (speech.kind === "idle") return null;
	const failed = speech.kind === "failed";
	return (
		<p
			className={failed ? "text-[16px] text-destructive" : "text-[16px]"}
			role={failed ? "alert" : "status"}
		>
			{failed ? speech.message : speechText[speech.kind]}
		</p>
	);
}
