import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "@health/contracts";
import {
	FamilyAnswer,
	urgentRequest,
	VoiceAnswer,
} from "@health/contracts/ask";
import type { CareProfile } from "@health/contracts/care-profile";
import { TripCheckIn } from "@health/contracts/trips";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import { type FamilyDb, openFamilyDb } from "../db";
import { ApiFailure, errorStatus, type FamilyEnv } from "../http";
import { elevenLabsVoice, maxAudioBytes } from "../integrations/elevenlabs";
import { askRoutes } from "./ask";
import { careRoutes } from "./care";
import { careProfileRoutes } from "./care-profile";
import { dbConfig, familyApp, openFamily, send, withDb } from "./test-family";
import { tripRoutes } from "./trips";

// Isolated local protocol servers stand in for Gemini, the Fetch.ai bridge, and ElevenLabs. Test
// credentials and synthetic records only: local protocol proof, not live-provider proof.
type Body = { input: unknown[]; system_instruction: string; store: boolean };
const geminiBodies: Body[] = [];
let gemini: (body: Body, request: Request) => Response | Promise<Response>;
const geminiServer = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const body = (await request.json()) as Body;
		geminiBodies.push(body);
		return gemini(body, request);
	},
});

const sleepSample = (sourceTime: string) => ({
	id: "11",
	familyId: "7",
	metric: "sleep_hours",
	value: 7.5,
	unit: "h",
	sourceTime,
	receivedAt: sourceTime,
	source: "synthetic-demo",
	synthetic: true,
	quality: "unvalidated",
	recordedBy: "c200".padEnd(64, "0"),
});
const bridgeCalls: Array<{ family_id: string; request: unknown }> = [];
let samples: unknown[] = [];
const bridge = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const call = (await request.json()) as {
			family_id: string;
			request: unknown;
		};
		bridgeCalls.push(call);
		return Response.json({
			family_id: call.family_id,
			status: 200,
			body: { tool: "health_samples", samples },
		});
	},
});

type Reply = (request: Request) => Response | Promise<Response>;
let transcribe: Reply;
let speech: Reply;
let transcriptions = 0;
const elevenLabs = Bun.serve({
	port: 0,
	fetch: (request) => {
		if (new URL(request.url).pathname !== "/v1/speech-to-text")
			return speech(request);
		transcriptions++;
		return transcribe(request);
	},
});
// Answers a provider request never, and resolves `aborted` when the caller drops it.
const stall = () => {
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const reply = (request: Request) => {
		request.signal.addEventListener("abort", () => aborted.resolve());
		started.resolve();
		return new Promise<Response>(() => {});
	};
	return { reply, started: started.promise, aborted: aborted.promise };
};
afterAll(() => {
	for (const server of [geminiServer, bridge, elevenLabs]) server.stop(true);
});

const functionCall = {
	status: "requires_action",
	model: "gemini-3.8-flash",
	steps: [
		{ type: "thought", signature: "sig-1" },
		{
			type: "function_call",
			id: "call_1",
			name: "health_samples",
			arguments: { metric: "sleep_hours", limit: 1 },
		},
	],
};
// The final turn is the structured answer: JSON text with `answer` and `follow_ups`.
const answer = (text: string, follow_ups: unknown = []) => ({
	status: "completed",
	model: "gemini-3.8-flash",
	steps: [
		{
			type: "model_output",
			content: [
				{ type: "text", text: JSON.stringify({ answer: text, follow_ups }) },
			],
		},
	],
});
const answerWith = (followUps: unknown) => {
	gemini = (body) =>
		Response.json(
			body.input.length === 1
				? functionCall
				: answer("Mom slept 7.5 hours (synthetic).", followUps),
		);
};
beforeEach(() => {
	geminiBodies.length = 0;
	bridgeCalls.length = 0;
	transcriptions = 0;
	samples = [sleepSample(new Date().toISOString())];
	answerWith(["Did Mom nap today?"]);
	transcribe = () =>
		Response.json({
			text: "How did Mom sleep?",
			language_code: "eng",
			language_probability: 0.98,
		});
	speech = () =>
		new Response(new Uint8Array([0xff, 0xf3, 1, 2]), {
			headers: { "content-type": "audio/mpeg" },
		});
});

const geminiConfig = {
	apiKey: "test-gemini-key",
	baseUrl: geminiServer.url.origin,
};
const fetchAgent = { bridgeUrl: bridge.url.origin, bridgeToken: "test-bridge" };
const voice = elevenLabsVoice({
	apiKey: "test-eleven-key",
	voiceId: "test-voice",
	baseUrl: elevenLabs.url.origin,
});
const mount = (configured = { gemini: true, fetch: true }) =>
	new Hono<FamilyEnv>()
		.use("/api/families/:familyId/*", async (c, next) => {
			c.set("familyId", BigInt(c.req.param("familyId") ?? ""));
			await next();
		})
		.route(
			"/api/families/:familyId",
			askRoutes({
				gemini: configured.gemini ? geminiConfig : undefined,
				fetchAgent: configured.fetch ? fetchAgent : undefined,
				voice,
			}),
		)
		.onError((error, c) => {
			if (!(error instanceof ApiFailure)) throw error;
			return c.json(
				{ error: error.code, message: error.message } satisfies ApiError,
				errorStatus[error.code],
			);
		});
const app = mount();
const ask = (body: unknown, target = app, signal?: AbortSignal) =>
	target.request("http://test/api/families/7/ask", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ?? null,
	});
const errorOf = async (response: Response) =>
	Schema.decodeUnknownSync(ApiError)(await response.json());

describe("POST /ask", () => {
	test("tool results go back to Gemini, and the answer lists the records it used", async () => {
		const response = await ask({ question: "How did Mom sleep?" });
		expect(response.status).toBe(200);
		const reply = Schema.decodeUnknownSync(FamilyAnswer)(await response.json());
		expect(reply.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.evidence.map((e) => [e.id, e.stale])).toEqual([["11", false]]);
		expect(reply.unavailable).toEqual([]);
		expect(reply.followUps).toEqual(["Did Mom nap today?"]);
		expect(bridgeCalls).toEqual([
			expect.objectContaining({
				family_id: "7",
				request: {
					tool: "health_samples",
					input: { metric: "sleep_hours", limit: 1 },
				},
			}),
		]);
		expect(geminiBodies[0]?.store).toBe(false);
		// The second request carries the model's steps unchanged, then the tool result.
		expect(geminiBodies[1]?.input.slice(1)).toEqual([
			...functionCall.steps,
			{
				type: "function_result",
				name: "health_samples",
				call_id: "call_1",
				result: [
					{ type: "text", text: expect.stringContaining('"value":7.5') },
				],
			},
		]);
	});

	test("records that are missing or old stay explicit", async () => {
		samples = [];
		const missing = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(missing.unavailable).toEqual(["sleep_hours"]);
		samples = [sleepSample("2020-01-01T00:00:00.000Z")];
		const old = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(old.evidence[0]?.stale).toBe(true);
	});

	test("without Gemini or Fetch.ai, nothing is answered or read", async () => {
		for (const configured of [
			{ gemini: false, fetch: true },
			{ gemini: true, fetch: false },
		]) {
			const response = await ask({ question: "Sleep?" }, mount(configured));
			expect(response.status).toBe(503);
			expect((await errorOf(response)).error).toBe("unavailable");
		}
		expect(bridgeCalls).toHaveLength(0);
	});

	test("an urgent request answers at once, with no model or record read, even when neither is set up", async () => {
		for (const [question, start] of [
			["I fell and I can't get up", "This sounds urgent."],
			["Me caí, ayúdame, no puedo levantarme", "Esto parece urgente."],
		] as const) {
			const response = await ask(
				{ question, asker: "wearer" },
				mount({ gemini: false, fetch: false }),
			);
			expect(response.status).toBe(200);
			const reply = Schema.decodeUnknownSync(FamilyAnswer)(
				await response.json(),
			);
			expect(reply.urgent).toBe(true);
			expect(reply.model).toBe("none");
			expect(reply.answer.startsWith(start)).toBe(true);
		}
		expect(geminiBodies).toHaveLength(0);
		expect(bridgeCalls).toHaveLength(0);
	});

	test("help requests and serious symptoms are urgent; repeats, feelings, and errands are not", () => {
		for (const text of [
			"Help!",
			"please help me",
			"I need help",
			"Call an ambulance",
			"I’ve fallen",
			"My chest hurts",
			"I can't breathe",
			"My arm is bleeding",
			"I took too many pills",
			"Llama al 911",
			"Me duele el pecho",
		])
			expect({ text, urgent: urgentRequest(text) !== null }).toEqual({
				text,
				urgent: true,
			});
		for (const text of [
			"Where is my daughter?",
			"What day is it today?",
			"I feel sad and confused",
			"I miss my husband",
			"Help me find my glasses",
			"I need help finding my keys",
			"I fell asleep after lunch",
			"Where are my blood pressure pills?",
			"¿Dónde está mi hija?",
		])
			expect({ text, urgent: urgentRequest(text) }).toEqual({
				text,
				urgent: null,
			});
	});

	test("invalid, failed, empty, or endless provider replies are upstream errors", async () => {
		const replies: Array<() => Response> = [
			() => new Response("quota detail", { status: 429 }),
			() => new Response("not json"),
			() => Response.json({ status: "completed", steps: "nope" }),
			() => Response.json(answer("   ")),
			// Plain text where the structured answer belongs.
			() =>
				Response.json({
					status: "completed",
					steps: [
						{
							type: "model_output",
							content: [{ type: "text", text: "Fine." }],
						},
					],
				}),
			() => Response.json({ status: "failed", steps: [] }),
			() => Response.json(functionCall),
		];
		for (const reply of replies) {
			gemini = reply;
			const response = await ask({ question: "Sleep?" });
			expect(response.status).toBe(502);
			expect((await errorOf(response)).message).not.toContain("quota detail");
		}
	});

	test("bad questions are rejected before any provider call", async () => {
		for (const body of [
			{},
			{ question: "  " },
			{ question: "Sleep?", timeZone: "Mars/Base" },
			{ question: "Sleep?", extra: true },
		])
			expect((await ask(body)).status).toBe(400);
		expect(geminiBodies).toHaveLength(0);
	});

	test("follow-ups are trimmed, 1 to 200 characters, distinct, and at most 3", async () => {
		answerWith([
			" Did Mom nap? ",
			"",
			"   ",
			"x".repeat(201),
			"y".repeat(200),
			"Did Mom nap?",
			"Bedtime?",
			"Steps today?",
		]);
		const reply = Schema.decodeUnknownSync(FamilyAnswer)(
			await (await ask({ question: "Sleep?" })).json(),
		);
		expect(reply.followUps).toEqual([
			"Did Mom nap?",
			"y".repeat(200),
			"Bedtime?",
		]);
	});

	test("follow-ups with a bad shape give none, and the answer stands", async () => {
		for (const followUps of [
			undefined,
			null,
			"Bedtime?",
			[1, "Bedtime?"],
			{ q: "Bedtime?" },
		]) {
			answerWith(followUps);
			const response = await ask({ question: "Sleep?" });
			expect(response.status).toBe(200);
			const reply = Schema.decodeUnknownSync(FamilyAnswer)(
				await response.json(),
			);
			expect(reply.answer).toBe("Mom slept 7.5 hours (synthetic).");
			expect(reply.followUps).toEqual([]);
		}
	});

	const MiB = 1024 * 1024;
	const file = (bytes: number, mimeType = "application/pdf") => ({
		name: "report.pdf",
		mimeType,
		data: Buffer.alloc(bytes, 97).toString("base64"),
	});

	test("files at the size limits are answered", async () => {
		for (const attachments of [
			[file(5 * MiB)],
			[file(4 * MiB), file(4 * MiB, "text/plain")],
		])
			expect((await ask({ question: "Sleep?", attachments })).status).toBe(200);
	});

	test("files over the limits are rejected before any provider call", async () => {
		const rejected: Array<[unknown[], string]> = [
			[[file(5 * MiB + 1)], "File 1 is larger than 5 MiB"],
			[[file(4 * MiB), file(4 * MiB + 1)], "8 MiB in total"],
			[[file(4.5 * MiB), file(4.5 * MiB)], "8 MiB of files at most"],
			[Array.from({ length: 5 }, () => file(1)), ""],
			[[file(1, "image/gif")], ""],
			[[{ ...file(1), data: "not base64!" }], ""],
			[[{ ...file(1), name: "" }], ""],
		];
		for (const [attachments, message] of rejected) {
			const response = await ask({ question: "Sleep?", attachments });
			expect(response.status).toBe(400);
			const error = await errorOf(response);
			expect(error.error).toBe("invalid_request");
			expect(error.message).toContain(message);
		}
		expect(geminiBodies).toHaveLength(0);
	});

	test("a client disconnect aborts the Gemini request", async () => {
		const hang = stall();
		gemini = (_body, request) => hang.reply(request);
		const cancel = new AbortController();
		const pending = ask({ question: "Sleep?" }, app, cancel.signal);
		await hang.started;
		cancel.abort();
		expect((await pending).status).toBe(499);
		// Hangs (and the test times out) if the provider request stays open.
		await hang.aborted;
	});
});

describe("POST /ask/voice", () => {
	const askVoice = (
		init: RequestInit = {},
		query = "?timeZone=Europe/Berlin",
	) =>
		app.request(`http://test/api/families/7/ask/voice${query}`, {
			method: "POST",
			headers: { "content-type": "audio/webm" },
			body: new Uint8Array([1, 2, 3]),
			...init,
		});

	test("transcribes, answers, and speaks in the question's language", async () => {
		const response = await askVoice();
		expect(response.status).toBe(200);
		const reply = Schema.decodeUnknownSync(VoiceAnswer)(await response.json());
		expect(reply.transcript.text).toBe("How did Mom sleep?");
		expect(reply.answer.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.answer.followUps).toEqual(["Did Mom nap today?"]);
		expect(reply.speech).toEqual({
			status: "ok",
			languageCode: "en",
			audio: Buffer.from([0xff, 0xf3, 1, 2]).toString("base64"),
		});
		expect(geminiBodies[0]?.system_instruction).toContain("Europe/Berlin");
	});

	test("a speech failure keeps the text answer and says why", async () => {
		speech = () => new Response("detail", { status: 500 });
		const reply = Schema.decodeUnknownSync(VoiceAnswer)(
			await (await askVoice()).json(),
		);
		expect(reply.answer.answer).toBe("Mom slept 7.5 hours (synthetic).");
		expect(reply.speech.status).toBe("upstream_error");
	});

	test("a recording at 10 MiB is answered", async () => {
		const response = await askVoice({ body: new Uint8Array(maxAudioBytes) });
		expect(response.status).toBe(200);
		expect(transcriptions).toBe(1);
	});

	test("a recording that is too large, empty, or not audio is rejected before any provider call", async () => {
		const rejected: Array<[RequestInit, string]> = [
			[{ body: new Uint8Array(maxAudioBytes + 1) }, "10 MiB at most"],
			[{ body: new Uint8Array() }, "The recording is empty"],
			[{ headers: { "content-type": "text/plain" } }, "audio/* Content-Type"],
			[{ headers: {} }, "audio/* Content-Type"],
		];
		for (const [init, message] of rejected) {
			const response = await askVoice(init);
			expect(response.status).toBe(400);
			expect(await errorOf(response)).toEqual({
				error: "invalid_request",
				message: expect.stringContaining(message),
			});
		}
		expect(transcriptions).toBe(0);
		expect(geminiBodies).toHaveLength(0);
	});

	test("silence, or a bad timeZone or asker, is rejected before Gemini", async () => {
		transcribe = () =>
			Response.json({
				text: "   ",
				language_code: "eng",
				language_probability: 0.5,
			});
		const silent = await askVoice();
		transcribe = () =>
			Response.json({
				text: "How did Mom sleep?",
				language_code: "eng",
				language_probability: 0.98,
			});
		for (const response of [
			silent,
			await askVoice({}, "?timeZone=Mars/Base"),
			await askVoice({}, "?asker=robot"),
		]) {
			expect(response.status).toBe(400);
			expect((await errorOf(response)).message).toBe(
				"No question was recognized, or timeZone or asker is not valid",
			);
		}
		expect(transcriptions).toBe(3);
		expect(geminiBodies).toHaveLength(0);
	});

	for (const stage of ["transcription", "answer", "speech"] as const)
		test(`a client disconnect during ${stage} aborts that provider request`, async () => {
			const hang = stall();
			if (stage === "transcription") transcribe = hang.reply;
			else if (stage === "answer")
				gemini = (_body, request) => hang.reply(request);
			else speech = hang.reply;
			const cancel = new AbortController();
			const pending = askVoice({ signal: cancel.signal });
			await hang.started;
			cancel.abort();
			expect((await pending).status).toBe(499);
			// Hangs (and the test times out) if the provider request stays open.
			await hang.aborted;
		});
});

// Needs the local SpacetimeDB that `bun run db:test` starts.
describe.skipIf(dbConfig === undefined)(
	"wearer questions with saved facts",
	() => {
		const profile: CareProfile = {
			preferredName: "Synthetic Sam",
			language: "es",
			timeZone: null,
			accessibilityNeeds: null,
			diagnoses: null,
			allergies: null,
			dietaryRestrictions: null,
			fluidRestrictions: null,
			activityRestrictions: null,
			routines: [{ name: "synthetic walk", time: "10:00" }],
			contacts: [
				{
					name: "Synthetic Ana",
					relationship: "daughter",
					phone: "+1 555 0100",
				},
			],
			familiarDestinations: null,
			devices: null,
			declinedPrompts: [],
		};
		// What Gemini is told when the wearer asks `db`'s app a question.
		const prompt = (db: FamilyDb, familyId: string, voiced = false) =>
			Effect.gen(function* () {
				geminiBodies.length = 0;
				const app = familyApp(
					db,
					familyId,
					askRoutes({ gemini: geminiConfig, fetchAgent, voice }),
				);
				const response = voiced
					? yield* Effect.promise(async () =>
							app.request("/ask/voice?asker=wearer", {
								method: "POST",
								headers: { "content-type": "audio/webm" },
								body: new Uint8Array([1, 2, 3]),
							}),
						)
					: yield* send(app, "POST", "/ask", {
							question: "Who visits me?",
							asker: "wearer",
						});
				expect(response.status).toBe(200);
				return geminiBodies[0]?.system_instruction ?? "";
			});

		test("only a health_records holder gives Gemini the profile, and never a phone number", () =>
			withDb((config) =>
				Effect.gen(function* () {
					const { db: owner, familyId } = yield* openFamily(config, "Ask care");
					const relative = yield* openFamilyDb(config);
					yield* Effect.promise(() =>
						owner.connection.reducers.addFamilyMember({
							familyId: BigInt(familyId),
							member: Identity.fromString(relative.identity),
						}),
					);
					const care = familyApp(owner, familyId, careProfileRoutes());
					for (const scope of [
						"family_access",
						"health_records",
						"care_plan_edit",
					])
						yield* send(care, "POST", "/care-access", {
							identity: owner.identity,
							scope,
							granted: true,
						});
					expect(
						(yield* send(care, "PUT", "/care-profile", profile)).status,
					).toBe(204);
					const granted = yield* prompt(owner, familyId);
					expect(granted).toContain("Their preferred name: Synthetic Sam.");
					expect(granted).toContain("Their preferred language: es.");
					expect(granted).toContain("Their routines: synthetic walk at 10:00.");
					expect(granted).toContain("Synthetic Ana (daughter)");
					expect(granted).not.toContain("555");

					// Membership alone gives no profile fact: the model says it is not saved.
					const member = yield* prompt(relative, familyId);
					expect(member).toContain("You are an assistant");
					expect(member).not.toContain("Synthetic");
				}),
			));

		test("the wearer hears the latest trip plan and only their own 3 newest requests", () =>
			withDb((config) =>
				Effect.gen(function* () {
					const { db: wearer, familyId } = yield* openFamily(
						config,
						"Ask memories",
					);
					const relative = yield* openFamilyDb(config);
					yield* Effect.promise(() =>
						wearer.connection.reducers.addFamilyMember({
							familyId: BigInt(familyId),
							member: Identity.fromString(relative.identity),
						}),
					);
					// Nothing saved: the model gets no saved-facts list at all.
					expect(yield* prompt(wearer, familyId)).not.toContain(
						"Saved facts you may repeat:",
					);

					const trips = familyApp(wearer, familyId, tripRoutes());
					const checkIn = yield* send(trips, "POST", "/trips/check-in", {
						source: "manual",
					});
					const trip = `/trips/${Schema.decodeUnknownSync(TripCheckIn)(checkIn.json).trip.id}`;
					const leaving = yield* send(trips, "POST", `${trip}/answer`, {
						answer: "leaving",
						purpose: "Synthetic checkup",
						destination: "Synthetic Clinic",
						notify: { departure: false, arrival: false },
						battery: null,
					});
					expect(leaving.status).toBe(200);
					const plan =
						/Their latest trip plan, stated \d{4}-\d\d-\d\dT[\d:.]+Z: Synthetic checkup, to Synthetic Clinic\. Now: /;
					const left = yield* prompt(wearer, familyId);
					expect(left).toContain("Saved facts you may repeat:");
					expect(left).toMatch(new RegExp(`${plan.source}leaving\\.`));
					expect(
						(yield* send(trips, "POST", `${trip}/answer`, {
							answer: "arrived",
						})).status,
					).toBe(200);
					// The plan stays; the step moves on. Every member may read the trip. Another identity's
					// view updates asynchronously, so the relative reads through a new connection, as the
					// server does per request.
					expect(yield* prompt(wearer, familyId)).toMatch(
						new RegExp(`${plan.source}arrived\\.`),
					);
					const relativeNow = yield* openFamilyDb({
						...config,
						token: relative.token,
					});
					expect(yield* prompt(relativeNow, familyId)).toMatch(
						new RegExp(`${plan.source}arrived\\.`),
					);

					const need = (db: FamilyDb, summary: string, kind = "help") =>
						send(familyApp(db, familyId, careRoutes()), "POST", "/needs", {
							clientId: crypto.randomUUID(),
							kind,
							summary,
							sampleIds: [],
							dueAt: null,
						});
					for (const n of [1, 2, 3])
						expect((yield* need(wearer, `Synthetic request ${n}`)).status).toBe(
							201,
						);
					expect(
						(yield* need(relative, "Synthetic relative request")).status,
					).toBe(201);
					expect(
						(yield* need(wearer, "Synthetic call request", "call_reminder"))
							.status,
					).toBe(201);

					const asked = (yield* prompt(wearer, familyId, true))
						.split("\n")
						.filter((line) => line.startsWith("They asked their family"));
					expect(asked).toEqual([
						expect.stringMatching(
							/^They asked their family, \d{4}-\d\d-\d\dT[\d:.]+Z: “Synthetic call request”\. Status: unresolved\.$/,
						),
						expect.stringContaining("“Synthetic request 3”"),
						expect.stringContaining("“Synthetic request 2”"),
					]);
					// The relative's own request is theirs alone to hear.
					const theirs = yield* prompt(relative, familyId);
					expect(theirs).toContain("“Synthetic relative request”");
					expect(theirs).not.toContain("Synthetic request");
					expect(theirs).not.toContain("Synthetic call request");
				}),
			));
	},
);
