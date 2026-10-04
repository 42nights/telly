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

/** Playback rate for "Slower". The browser keeps the pitch. */
const SLOW_RATE = 0.75;

type SayOptions = {
	/** The MP3 that came with the text (base64). Without it, the server makes speech. */
	readonly mp3Base64?: string | undefined;
	/** The language to speak. Without it, the provider infers the language from the text. */
	readonly languageCode?: string | undefined;
	readonly slow?: boolean;
};

/** The audio URL to play: the given MP3, or speech for `text` from `POST /voice/speech`. */
const audioUrl = async (
	familyId: string | null,
	text: string,
	{ mp3Base64, languageCode }: SayOptions,
	signal: AbortSignal,
): Promise<ApiResult<string>> => {
	if (mp3Base64 !== undefined)
		return { kind: "ready", value: `data:audio/mpeg;base64,${mp3Base64}` };
	if (familyId === null) return { kind: "signed_out" };
	const result = await apiBlob(familyPath(familyId, "/voice/speech"), {
		body: {
			text: text.slice(0, 2000),
			...(languageCode === undefined ? {} : { languageCode }),
		},
		signal,
	});
	return result.kind === "ready"
		? { kind: "ready", value: URL.createObjectURL(result.value) }
		: result;
};

const revoke = (url: string | undefined) => {
	if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
};

type Playing = { controller: AbortController; audio: HTMLAudioElement | null };

/**
 * Reads real text aloud, one text at a time: the MP3 that came with it when given, otherwise
 * ElevenLabs speech from `POST /voice/speech`. `key` names what is spoken, so each button can show
 * its own state. The audio of the last key is kept, so "Say it again" and "Slower" make no new
 * provider call.
 */
export function useSpeech(familyId: string | null) {
	const [speech, setSpeech] = useState<Speech>({ kind: "idle", key: null });
	const playing = useRef<Playing | null>(null);
	const kept = useRef<{ key: string; url: string } | null>(null);

	const halt = () => {
		playing.current?.controller.abort();
		playing.current?.audio?.pause();
		playing.current = null;
	};
	useEffect(
		() => () => {
			playing.current?.controller.abort();
			playing.current?.audio?.pause();
			revoke(kept.current?.url);
		},
		[],
	);

	/** Stops the voice now. The key stays, so its button still offers "Say it again". */
	const stop = () => {
		halt();
		setSpeech((current) => ({ kind: "idle", key: current.key }));
	};

	const say = async (key: string, text: string, options: SayOptions = {}) => {
		halt();
		const now: Playing = { controller: new AbortController(), audio: null };
		const { signal } = now.controller;
		playing.current = now;
		let url = kept.current?.key === key ? kept.current.url : null;
		if (url === null) {
			setSpeech({ kind: "loading", key });
			const result = await audioUrl(familyId, text, options, signal).catch(
				() => null,
			);
			if (result === null || signal.aborted) {
				if (result?.kind === "ready") revoke(result.value);
				return;
			}
			if (result.kind !== "ready") {
				playing.current = null;
				setSpeech({ kind: "failed", key, message: failureText[result.kind] });
				return;
			}
			revoke(kept.current?.url);
			kept.current = { key, url: result.value };
			url = result.value;
		}
		const audio = new Audio(url);
		audio.defaultPlaybackRate = options.slow === true ? SLOW_RATE : 1;
		audio.playbackRate = audio.defaultPlaybackRate;
		audio.onended = () => {
			if (playing.current === now) playing.current = null;
			setSpeech({ kind: "idle", key });
		};
		now.audio = audio;
		setSpeech({ kind: "speaking", key });
		await audio.play().catch(() => {
			if (signal.aborted) return;
			halt();
			setSpeech({
				kind: "failed",
				key,
				message: "The browser blocked the sound. Press the button again.",
			});
		});
	};

	return { speech, say, stop };
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
