import "../test/setup";

import { describe, expect, test } from "bun:test";
import { FakeAudio, installFakeAudio } from "../test/audio";
import {
	act,
	installDom,
	render,
	renderHook,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";
import { SpeechLine, useSpeech } from "./speech";

installDom();
const urls = installFakeAudio();

const speechPath = "POST /api/families/f1/voice/speech";

describe("useSpeech", () => {
	test("plays the MP3 that came with the text, without asking the server", async () => {
		const calls = serve({});
		const { result } = renderHook(() => useSpeech("f1"));
		expect(result.current.speech).toEqual({ kind: "idle", key: null });
		await act(() => result.current.say("a", "Hello", { mp3Base64: "SUQz" }));
		expect(calls).toEqual([]);
		expect(FakeAudio.made.map((a) => [a.src, a.playbackRate])).toEqual([
			["data:audio/mpeg;base64,SUQz", 1],
		]);
		expect(result.current.speech).toEqual({ kind: "speaking", key: "a" });
		act(() => FakeAudio.made[0]?.onended?.());
		expect(result.current.speech).toEqual({ kind: "idle", key: "a" });
	});

	test("asks the voice route for speech in the given language, cut to 2000 characters, and plays it slower", async () => {
		const calls = serve({ [speechPath]: { json: "mp3" } });
		const { result } = renderHook(() => useSpeech("f1"));
		const text = "x".repeat(2500);
		let said: Promise<void> = Promise.resolve();
		act(() => {
			said = result.current.say("a", text, { languageCode: "es", slow: true });
		});
		expect(result.current.speech).toEqual({ kind: "loading", key: "a" });
		await act(() => said);
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/families/f1/voice/speech",
				body: { text: "x".repeat(2000), languageCode: "es" },
			},
		]);
		const audio = FakeAudio.made[0];
		expect([
			audio?.src,
			audio?.defaultPlaybackRate,
			audio?.playbackRate,
		]).toEqual(["blob:1", 0.75, 0.75]);
		expect(result.current.speech).toEqual({ kind: "speaking", key: "a" });
	});

	test("says the same text again from the kept audio, and frees it for a new text and on unmount", async () => {
		const calls = serve({ [speechPath]: { json: "mp3" } });
		const { result, unmount } = renderHook(() => useSpeech("f1"));
		await act(() => result.current.say("a", "One"));
		await act(() => result.current.say("a", "One"));
		expect(calls.length).toBe(1);
		expect(calls[0]?.body).toEqual({ text: "One" });
		expect(FakeAudio.made.map((a) => a.src)).toEqual(["blob:1", "blob:1"]);
		expect(FakeAudio.made[0]?.paused).toBe(true);
		await act(() => result.current.say("b", "Two"));
		expect(calls.length).toBe(2);
		expect(urls.revoked).toEqual(["blob:1"]);
		unmount();
		expect(urls.revoked).toEqual(["blob:1", "blob:2"]);
		expect(FakeAudio.made[2]?.paused).toBe(true);
	});

	test("asks for sign-in without a family, and sends nothing", async () => {
		const calls = serve({});
		const { result } = renderHook(() => useSpeech(null));
		await act(() => result.current.say("a", "Hello"));
		expect(calls).toEqual([]);
		expect(result.current.speech).toEqual({
			kind: "failed",
			key: "a",
			message: "Sign in to hear this read aloud.",
		});
	});

	test.each([
		[401, "Sign in to hear this read aloud."],
		[403, "You can't use the voice for this person."],
		[503, "The voice is not available right now."],
		[500, "I couldn't read this aloud."],
	])("says why the voice failed on HTTP %d", async (status, message) => {
		serve({ [speechPath]: { status } });
		const { result } = renderHook(() => useSpeech("f1"));
		await act(() => result.current.say("a", "Hello"));
		expect(result.current.speech).toEqual({
			kind: "failed",
			key: "a",
			message,
		});
		expect(FakeAudio.made).toEqual([]);
	});

	test("stop while the voice loads keeps the key idle and drops the late audio", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({ [speechPath]: () => reply.promise });
		const { result } = renderHook(() => useSpeech("f1"));
		let said: Promise<void> = Promise.resolve();
		act(() => {
			said = result.current.say("a", "Hello");
		});
		expect(result.current.speech).toEqual({ kind: "loading", key: "a" });
		// The session token is read before the request goes: wait until it is pending.
		await waitFor(() => expect(calls).toHaveLength(1));
		act(() => result.current.stop());
		expect(result.current.speech).toEqual({ kind: "idle", key: "a" });
		reply.resolve({ json: "mp3" });
		await act(() => said);
		expect(urls.revoked).toEqual(["blob:1"]);
		expect(FakeAudio.made).toEqual([]);
		expect(result.current.speech).toEqual({ kind: "idle", key: "a" });
	});

	test("a new text replaces one still loading, and the first one's failure is ignored", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({ [speechPath]: () => reply.promise });
		const { result } = renderHook(() => useSpeech("f1"));
		let first: Promise<void> = Promise.resolve();
		act(() => {
			first = result.current.say("a", "Hello");
		});
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(() => result.current.say("b", "Bye", { mp3Base64: "SUQz" }));
		reply.reject(new Error("aborted"));
		await act(() => first);
		expect(result.current.speech).toEqual({ kind: "speaking", key: "b" });
		expect(FakeAudio.made.map((a) => a.src)).toEqual([
			"data:audio/mpeg;base64,SUQz",
		]);
	});

	test("says the browser blocked the sound when playing is refused", async () => {
		serve({});
		FakeAudio.play = () => Promise.reject(new Error("NotAllowedError"));
		const { result } = renderHook(() => useSpeech("f1"));
		await act(() => result.current.say("a", "Hello", { mp3Base64: "SUQz" }));
		expect(result.current.speech).toEqual({
			kind: "failed",
			key: "a",
			message: "The browser blocked the sound. Press the button again.",
		});
		expect(FakeAudio.made[0]?.paused).toBe(true);
	});

	test("a refused play after stop stays idle", async () => {
		serve({});
		const playing = Promise.withResolvers<void>();
		FakeAudio.play = () => playing.promise;
		const { result } = renderHook(() => useSpeech("f1"));
		let said: Promise<void> = Promise.resolve();
		act(() => {
			said = result.current.say("a", "Hello", { mp3Base64: "SUQz" });
		});
		await waitFor(() =>
			expect(result.current.speech).toEqual({ kind: "speaking", key: "a" }),
		);
		act(() => result.current.stop());
		playing.reject(new Error("AbortError"));
		await act(() => said);
		expect(result.current.speech).toEqual({ kind: "idle", key: "a" });
	});
});

describe("SpeechLine", () => {
	test("shows nothing while idle", () => {
		const view = render(<SpeechLine speech={{ kind: "idle", key: "a" }} />);
		expect(view.container.innerHTML).toBe("");
	});

	test.each([
		["loading", "Getting the voice…"],
		["speaking", "Speaking…"],
	] as const)("tells the %s state as a status", (kind, text) => {
		const view = render(<SpeechLine speech={{ kind, key: "a" }} />);
		expect(view.getByRole("status").textContent).toBe(text);
	});

	test("shows a failure as an alert", () => {
		const view = render(
			<SpeechLine
				speech={{ kind: "failed", key: "a", message: "No voice." }}
			/>,
		);
		expect(view.getByRole("alert").textContent).toBe("No voice.");
	});
});
