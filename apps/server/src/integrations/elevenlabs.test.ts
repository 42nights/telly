// A local protocol server stands in for api.elevenlabs.io. Test key and synthetic audio only:
// local protocol proof, not a live ElevenLabs call.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Effect, Exit } from "effect";
import { elevenLabsVoice, maxAudioBytes, type VoiceError } from "./elevenlabs";

type Seen = {
	method: string;
	path: string;
	search: string;
	headers: Request["headers"];
	form?: {
		get: (name: string) => string | Blob | null;
		has: (name: string) => boolean;
	};
	json?: unknown;
};
const seen: Seen[] = [];
let reply: (request: Request) => Response | Promise<Response>;
const server = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const url = new URL(request.url);
		const type = request.headers.get("content-type") ?? "";
		seen.push({
			method: request.method,
			path: url.pathname,
			search: url.search,
			headers: request.headers,
			...(type.startsWith("multipart/form-data")
				? { form: await request.clone().formData() }
				: { json: await request.clone().json() }),
		});
		return reply(request);
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	seen.length = 0;
});

const config = {
	apiKey: "test-eleven-key",
	voiceId: "voice/1",
	baseUrl: server.url.origin,
};
const voice = elevenLabsVoice(config);
const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const transcript = (language_code: string) =>
	Response.json({
		text: "Hello there",
		language_code,
		language_probability: 0.97,
		words: [],
	});
const mp3 = (bytes = new Uint8Array([0xff, 0xfb, 0x90])) =>
	new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
const failure = (effect: Effect.Effect<unknown, VoiceError>) =>
	Effect.runPromise(Effect.flip(effect));

describe("elevenLabsVoice", () => {
	test("without a key both operations are unavailable and call no provider", async () => {
		const off = elevenLabsVoice({ ...config, apiKey: undefined });
		for (const effect of [
			off.transcribe(audio),
			off.synthesize({ text: "Hi" }),
		])
			expect(await failure(effect)).toMatchObject({
				_tag: "VoiceError",
				reason: "unavailable",
			});
		expect(seen).toHaveLength(0);
	});

	test("transcription sends the recording, model, and hint with the key", async () => {
		reply = () => transcript("spa");
		const result = await Effect.runPromise(voice.transcribe(audio, "es"));
		expect(result).toEqual({
			text: "Hello there",
			languageCode: "es",
			languageProbability: 0.97,
		});
		const [request] = seen;
		expect(request?.method).toBe("POST");
		expect(request?.path).toBe("/v1/speech-to-text");
		expect(request?.headers.get("xi-api-key")).toBe("test-eleven-key");
		expect(request?.form?.get("model_id")).toBe("scribe_v2");
		expect(request?.form?.get("timestamps_granularity")).toBe("none");
		expect(request?.form?.get("language_code")).toBe("es");
		const file = request?.form?.get("file");
		expect(file).toBeInstanceOf(Blob);
		expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	test.each([
		["ENG", "en"],
		["cmn", "zh"],
		["fr", "fr"],
		["fil", "fil"],
	])("a detected language %s is reported as %s", async (code, expected) => {
		reply = () => transcript(code);
		const result = await Effect.runPromise(voice.transcribe(audio));
		expect(result.languageCode).toBe(expected);
		expect(seen[0]?.form?.has("language_code")).toBe(false);
	});

	test("speech posts the text to the voice and returns the MP3 bytes", async () => {
		reply = () => mp3();
		const bytes = await Effect.runPromise(
			voice.synthesize({ text: "Take your pill", languageCode: "en" }),
		);
		expect(bytes).toEqual(new Uint8Array([0xff, 0xfb, 0x90]));
		const [request] = seen;
		expect(request?.path).toBe("/v1/text-to-speech/voice%2F1");
		expect(request?.search).toBe("?output_format=mp3_44100_128");
		expect(request?.headers.get("xi-api-key")).toBe("test-eleven-key");
		expect(request?.headers.get("accept")).toBe("audio/mpeg");
		expect(request?.json).toEqual({
			text: "Take your pill",
			model_id: "eleven_flash_v2_5",
			language_code: "en",
		});
	});

	test.each([401, 429, 500])(
		"HTTP %i is an upstream_error naming the operation and status only",
		async (status) => {
			reply = () => new Response("detail test-eleven-key", { status });
			expect(await failure(voice.transcribe(audio))).toMatchObject({
				reason: "upstream_error",
				message: `ElevenLabs transcription failed with HTTP ${status}`,
			});
			expect(await failure(voice.synthesize({ text: "Hi" }))).toMatchObject({
				reason: "upstream_error",
				message: `ElevenLabs speech failed with HTTP ${status}`,
			});
		},
	);

	test.each<[string, () => Response]>([
		["not JSON", () => new Response("<html>")],
		[
			"missing a field",
			() => Response.json({ text: "Hi", language_code: "en" }),
		],
		["an invalid language code", () => transcript("english")],
	])("a transcript that is %s is invalid", async (_, make) => {
		reply = make;
		expect(await failure(voice.transcribe(audio))).toMatchObject({
			reason: "upstream_error",
			message: "ElevenLabs sent an invalid transcription response",
		});
	});

	test.each<[string, () => Response]>([
		["not audio/mpeg", () => Response.json({ audio: "x" })],
		["empty", () => mp3(new Uint8Array())],
	])("speech that is %s is invalid", async (_, make) => {
		reply = make;
		expect(await failure(voice.synthesize({ text: "Hi" }))).toMatchObject({
			reason: "upstream_error",
			message: "ElevenLabs sent an invalid speech response",
		});
	});

	test("a reply larger than the limit is refused", async () => {
		reply = () => mp3(new Uint8Array(maxAudioBytes + 1));
		expect(await failure(voice.synthesize({ text: "Hi" }))).toMatchObject({
			reason: "upstream_error",
			message: `ElevenLabs sent more than ${maxAudioBytes} bytes`,
		});
	});

	test("speech of exactly the limit is accepted", async () => {
		reply = () => mp3(new Uint8Array(maxAudioBytes));
		const bytes = await Effect.runPromise(voice.synthesize({ text: "Hi" }));
		expect(bytes.byteLength).toBe(maxAudioBytes);
	});

	test("an unreachable provider is an upstream_error", async () => {
		const baseUrl = "http://127.0.0.1:1";
		const off = elevenLabsVoice({ ...config, baseUrl });
		expect(await failure(off.transcribe(audio))).toMatchObject({
			reason: "upstream_error",
			message: "ElevenLabs transcription could not be reached",
		});
	});

	test("a provider slower than the limit times out and is aborted", async () => {
		// Shortens the 30 s limit; the adapter's own timeout path still runs.
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const short = spyOn(AbortSignal, "timeout").mockImplementation(() =>
			timeout(50),
		);
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		reply = (request) => {
			request.signal.addEventListener("abort", () => resolve());
			return new Promise<Response>(() => {});
		};
		try {
			expect(await failure(voice.synthesize({ text: "Hi" }))).toMatchObject({
				reason: "upstream_error",
				message: "ElevenLabs speech timed out after 30 s",
			});
			await aborted;
		} finally {
			short.mockRestore();
		}
	});

	test("interrupting the effect aborts the provider request", async () => {
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		reply = (request) => {
			request.signal.addEventListener("abort", () => resolve());
			arrive();
			return new Promise<Response>(() => {});
		};
		const controller = new AbortController();
		const run = Effect.runPromiseExit(voice.transcribe(audio), {
			signal: controller.signal,
		});
		await arrived;
		controller.abort();
		expect(Exit.isFailure(await run)).toBe(true);
		await aborted;
	});
});
