// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { afterEach, expect, spyOn, test } from "bun:test";
import type { FamilyAnswer } from "@health/contracts/ask";

import { act, renderHook, serve, setupDom, signIn, waitFor } from "../test/dom";
import { useAsk } from "./use-ask";

setupDom();

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const VOICE_PATH = `/api/families/f1/ask/voice?timeZone=${encodeURIComponent(ZONE)}`;

const ANSWER: FamilyAnswer = {
	answer: "Her heart rate was steady.",
	evidence: [],
	alerts: [],
	unavailable: [],
	model: "gemini-test",
	answeredAt: "2026-10-04T10:00:00.000Z",
	followUps: [],
	urgent: false,
};

const TRANSCRIPT = {
	text: "How did she sleep?",
	languageCode: "en",
	languageProbability: 1,
};

const realAudio = globalThis.Audio;
const played: string[] = [];
let playFails = false;
/** Plays nothing; records the source, or refuses like a browser without a user gesture. */
class FakeAudio {
	constructor(readonly src: string) {}
	play() {
		played.push(this.src);
		return playFails ? Promise.reject(new Error("blocked")) : Promise.resolve();
	}
}

afterEach(() => {
	globalThis.Audio = realAudio;
	played.length = 0;
	playFails = false;
});

test("a question goes to POST /ask with the time zone and files, then shows its answer", async () => {
	signIn();
	const calls = serve({ "POST /api/families/f1/ask": { json: ANSWER } });
	const { result } = renderHook(() => useAsk("f1"));
	expect(result.current.status).toEqual({ kind: "unknown" });

	const file = { name: "a.txt", mimeType: "text/plain" as const, data: "aGk=" };
	let answered = false;
	await act(async () => {
		answered = await result.current.ask("How is she?", [file]);
	});
	expect(answered).toBe(true);
	expect(calls[0]?.body).toEqual({
		question: "How is she?",
		timeZone: ZONE,
		attachments: [file],
	});
	expect(result.current.status).toEqual({ kind: "ready" });
	expect(result.current.asks).toEqual([
		{
			id: expect.any(String),
			question: "How is she?",
			files: ["a.txt"],
			askedAt: expect.any(String),
			state: { kind: "answered", answer: ANSWER },
		},
	]);
});

test("while Gemini works the ask is pending, and without files none are sent", async () => {
	signIn();
	const reply = Promise.withResolvers<{ json: FamilyAnswer }>();
	const calls = serve({ "POST /api/families/f1/ask": () => reply.promise });
	const { result } = renderHook(() => useAsk("f1"));
	let done: Promise<boolean> = Promise.resolve(false);
	act(() => {
		done = result.current.ask("Hello?", []);
	});
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(result.current.asks[0]?.state).toEqual({ kind: "pending" });
	expect(calls[0]?.body).toEqual({ question: "Hello?", timeZone: ZONE });
	await act(async () => {
		reply.resolve({ json: ANSWER });
		await done;
	});
	expect(result.current.asks[0]?.state.kind).toBe("answered");
});

test("a 503 marks Gemini unavailable and the ask failed with the server's reason", async () => {
	signIn();
	const errors = spyOn(console, "error").mockImplementation(() => {});
	serve({
		"POST /api/families/f1/ask": {
			status: 503,
			json: { error: "unavailable", message: "Gemini is not configured" },
		},
	});
	const { result } = renderHook(() => useAsk("f1"));
	let answered = true;
	await act(async () => {
		answered = await result.current.ask("Hi", []);
	});
	expect(answered).toBe(false);
	expect(result.current.status).toEqual({
		kind: "unavailable",
		message: "Gemini is not configured",
	});
	expect(result.current.asks[0]?.state).toEqual({
		kind: "failed",
		message: "Gemini is not configured",
	});
	errors.mockRestore();
});

test("signed out, the ask fails with Sign in first and the Gemini status stays unknown", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const calls = serve({});
	const { result } = renderHook(() => useAsk("f1"));
	await act(async () => {
		await result.current.ask("Hi", []);
	});
	expect(calls).toEqual([]);
	expect(result.current.status).toEqual({ kind: "unknown" });
	expect(result.current.asks[0]?.state).toEqual({
		kind: "failed",
		message: "Sign in first.",
	});
	errors.mockRestore();
});

test("a voice question posts the recording, shows the transcript, and plays the spoken answer", async () => {
	signIn();
	globalThis.Audio = FakeAudio as unknown as typeof Audio;
	const calls = serve({
		[`POST ${VOICE_PATH}`]: {
			json: {
				transcript: TRANSCRIPT,
				answer: ANSWER,
				speech: { status: "ok", languageCode: "en", audio: "AAAA" },
			},
		},
	});
	const { result } = renderHook(() => useAsk("f1"));
	const audio = new Blob(["abc"], { type: "audio/webm" });
	let shown: string | null = "unset";
	await act(async () => {
		shown = await result.current.askVoice(audio);
	});
	expect(shown).toBeNull();
	expect(calls[0]?.body).toBe(audio);
	expect(played).toEqual(["data:audio/mpeg;base64,AAAA"]);
	expect(result.current.asks[0]).toMatchObject({
		question: "How did she sleep?",
		files: [],
		state: { kind: "answered", answer: ANSWER },
	});
});

test("a spoken answer that cannot play is logged, and the text answer stands", async () => {
	signIn();
	globalThis.Audio = FakeAudio as unknown as typeof Audio;
	playFails = true;
	const errors = spyOn(console, "error").mockImplementation(() => {});
	serve({
		[`POST ${VOICE_PATH}`]: {
			json: {
				transcript: TRANSCRIPT,
				answer: ANSWER,
				speech: { status: "ok", languageCode: "en", audio: "AAAA" },
			},
		},
	});
	const { result } = renderHook(() => useAsk("f1"));
	let shown: string | null = "unset";
	await act(async () => {
		shown = await result.current.askVoice(
			new Blob(["a"], { type: "audio/webm" }),
		);
	});
	expect(shown).toBeNull();
	expect(errors).toHaveBeenCalledWith(
		"Spoken answer did not play:",
		expect.any(Error),
	);
	expect(result.current.asks[0]?.state.kind).toBe("answered");
	errors.mockRestore();
});

test("without speech the voice answer says why, and plays nothing", async () => {
	signIn();
	globalThis.Audio = FakeAudio as unknown as typeof Audio;
	serve({
		[`POST ${VOICE_PATH}`]: {
			json: {
				transcript: TRANSCRIPT,
				answer: ANSWER,
				speech: { status: "unavailable", message: "No voice provider" },
			},
		},
	});
	const { result } = renderHook(() => useAsk("f1"));
	let shown: string | null = "unset";
	await act(async () => {
		shown = await result.current.askVoice(
			new Blob(["a"], { type: "audio/webm" }),
		);
	});
	expect(shown).toBe("No spoken answer: No voice provider");
	expect(played).toEqual([]);
});

test("a failed voice question shows as not answered and returns no message", async () => {
	signIn();
	const errors = spyOn(console, "error").mockImplementation(() => {});
	serve({ [`POST ${VOICE_PATH}`]: "network-error" });
	const { result } = renderHook(() => useAsk("f1"));
	let shown: string | null = "unset";
	await act(async () => {
		shown = await result.current.askVoice(
			new Blob(["a"], { type: "audio/webm" }),
		);
	});
	expect(shown).toBeNull();
	expect(result.current.asks[0]).toMatchObject({
		question: "Voice question",
		state: { kind: "failed" },
	});
	expect(result.current.status).toEqual({ kind: "unknown" });
	errors.mockRestore();
});
