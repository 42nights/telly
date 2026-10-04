import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, VoiceTranscript } from "@health/contracts";
import { Schema } from "effect";
import { Hono } from "hono";
import { elevenLabsVoice } from "../integrations/elevenlabs";
import { voiceRoutes } from "./voice";

// Isolated local protocol server standing in for api.elevenlabs.io. Test credentials only.
let provider: (request: Request) => Response | Promise<Response>;
const seen: Request[] = [];
const server = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const { url, method, headers } = request;
		seen.push(
			new Request(url, { method, headers, body: await request.blob() }),
		);
		return provider(request);
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	seen.length = 0;
});

const mount = (apiKey: string | undefined) =>
	new Hono().route(
		"/api/families/:familyId",
		voiceRoutes(
			elevenLabsVoice({
				apiKey,
				voiceId: "test-voice",
				baseUrl: server.url.origin,
			}),
		),
	);
const app = mount("test-key");
const base = "http://test/api/families/1/voice";

const speak = (body: unknown, target = app) =>
	target.request(`${base}/speech`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const transcribe = (
	audio: Uint8Array<ArrayBuffer> | string,
	type = "audio/webm",
	query = "",
) =>
	app.request(`${base}/transcriptions${query}`, {
		method: "POST",
		headers: { "content-type": type },
		body: audio,
	});

const errorOf = async (response: Response) =>
	Schema.decodeUnknownSync(ApiError)(await response.json());

describe("voice routes", () => {
	test("an unconfigured provider is unavailable and returns no audio", async () => {
		const response = await speak({ text: "Hola" }, mount(undefined));
		expect(response.status).toBe(503);
		expect((await errorOf(response)).error).toBe("unavailable");
		expect(seen).toHaveLength(0);
	});

	test("speech is synthesized in the requested language", async () => {
		const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
		provider = () =>
			new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
		const response = await speak({
			text: "Hora de caminar",
			languageCode: "es",
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp3);
		const [request] = seen;
		expect(new URL(request?.url ?? "").pathname).toBe(
			"/v1/text-to-speech/test-voice",
		);
		expect(request?.headers.get("xi-api-key")).toBe("test-key");
		expect(await request?.json()).toEqual({
			text: "Hora de caminar",
			model_id: "eleven_flash_v2_5",
			language_code: "es",
		});
	});

	test("transcription reports the detected language as ISO 639-1", async () => {
		provider = () =>
			Response.json({
				text: "¿Tomé mi medicina?",
				language_code: "spa",
				language_probability: 0.97,
				words: [],
			});
		const audio = new Uint8Array([1, 2, 3, 4]);
		const response = await transcribe(audio);
		expect(response.status).toBe(200);
		expect(
			Schema.decodeUnknownSync(VoiceTranscript)(await response.json()),
		).toEqual({
			text: "¿Tomé mi medicina?",
			languageCode: "es",
			languageProbability: 0.97,
		});
		const form = await seen[0]?.formData();
		expect(form?.get("model_id")).toBe("scribe_v2");
		const file = form?.get("file");
		expect(file instanceof Blob && (await file.bytes())).toEqual(audio);
	});

	test("invalid recordings and requests never reach the provider", async () => {
		expect(
			(await transcribe(new Uint8Array(10 * 1024 * 1024 + 1))).status,
		).toBe(413);
		expect((await transcribe(new Uint8Array(0))).status).toBe(400);
		expect((await transcribe("text", "text/plain")).status).toBe(415);
		expect(
			(await transcribe(new Uint8Array(4), "audio/webm", "?languageCode=en-US"))
				.status,
		).toBe(400);
		expect((await speak({ text: "   " })).status).toBe(400);
		expect((await speak({ text: "x".repeat(2001) })).status).toBe(400);
		expect(seen).toHaveLength(0);
	});

	test("provider failures are typed and do not echo the provider body", async () => {
		provider = () => new Response("invalid api key test-key", { status: 401 });
		const rejected = await speak({ text: "Hello" });
		expect(rejected.status).toBe(502);
		const error = await errorOf(rejected);
		expect(error.error).toBe("upstream_error");
		expect(error.message).not.toContain("test-key");

		provider = () => Response.json({ text: "no language" });
		expect((await transcribe(new Uint8Array(4))).status).toBe(502);

		provider = () =>
			new Response("<html/>", { headers: { "content-type": "text/html" } });
		expect((await speak({ text: "Hello" })).status).toBe(502);
	});

	test("a client disconnect aborts the provider request", async () => {
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		provider = (request) => {
			request.signal.addEventListener("abort", () => resolve());
			arrive();
			return new Promise<Response>(() => {});
		};
		const client = new AbortController();
		const pending = app.request(`${base}/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Hello" }),
			signal: client.signal,
		});
		await arrived;
		client.abort();
		await aborted;
		expect((await pending).status).toBe(499);
	});
});
