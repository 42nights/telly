// Proves the family chat paths the web composer takes (apps/web/src/components/chat): the creator
// signs in, makes a family, and adds a member who signs in too. With AI on, Send is `POST /ask`:
// Gemini answers the asker, and the answer is not stored in the family thread (the web keeps asks
// for the session only). With "Family only", Send is `POST /messages`: Gemini is never called and
// the member reads the message. Real server and SpacetimeDB; the issuer and Gemini are fake.
import { describe, expect, test } from "bun:test";
import { ApiError, FamilyMessage } from "@health/contracts";
import { FamilyAnswer } from "@health/contracts/ask";
import { FamilyMessages } from "@health/contracts/chat";
import { Schema } from "effect";
import {
	addMember,
	createFamily,
	integration,
	json,
	type ProviderCall,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;
// The same server without the Fetch.ai bridge; its users sign in on its own issuer.
const bare = integration
	? await startIntegration({
			TELLY_FETCH_BRIDGE_URL: undefined,
			TELLY_FETCH_BRIDGE_TOKEN: undefined,
		})
	: undefined;

/** The Gemini calls in `calls` after index `from`, as the JSON bodies sent. */
const geminiCalls = (calls: readonly ProviderCall[], from = 0) =>
	calls
		.slice(from)
		.filter((call) => call.path === "/v1beta/interactions")
		.map((call) => JSON.parse(call.body));

const thread = async (user: User, path: string) =>
	(await json(FamilyMessages, await user.call("GET", `${path}/messages`)))
		.messages;

describe.skipIf(!it)("family chat flow", () => {
	const run = crypto.randomUUID();
	let owner: User;
	let member: User;
	let path: string;

	test("the creator makes a family and adds a member who signs in", async () => {
		if (!it) return;
		owner = await it.signIn(`chat-owner-${run}`);
		member = await it.signIn(`chat-member-${run}`);
		path = (await createFamily(owner, "Chat")).path;
		await addMember(owner, path, member);
		expect(await thread(member, path)).toEqual([]);
	});

	// #256: without the bridge, the tools read the asker's own database and Gemini still answers.
	test("without a Fetch.ai bridge, Gemini answers from the asker's database", async () => {
		if (!bare) return;
		bare.providers.gemini = () =>
			Response.json({
				status: "completed",
				model: "gemini-3.8-flash",
				steps: [
					{
						type: "model_output",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									answer: "No sleep is recorded yet.",
									follow_ups: [],
								}),
							},
						],
					},
				],
			});
		const asker = await bare.signIn(`chat-bare-${run}`);
		const { path: barePath } = await createFamily(asker, "Bare");
		const answer = await json(
			FamilyAnswer,
			await asker.call("POST", `${barePath}/ask`, {
				question: "How did Mom sleep?",
				timeZone: "Europe/Berlin",
			}),
		);
		expect(answer.answer).toBe("No sleep is recorded yet.");
		expect(geminiCalls(bare.calls)).toHaveLength(1);
	});

	test("AI on: Gemini answers the asker, and the family thread keeps no copy", async () => {
		if (!it) return;
		const question = "How did Mom sleep last night?";
		it.providers.gemini = () =>
			Response.json({
				status: "completed",
				model: "gemini-3.8-flash",
				steps: [
					{
						type: "model_output",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									answer: "Mom slept seven hours.",
									follow_ups: ["Was that more than usual?"],
								}),
							},
						],
					},
				],
			});
		const from = it.calls.length;
		const answer = await json(
			FamilyAnswer,
			await owner.call("POST", `${path}/ask`, {
				question,
				timeZone: "Europe/Berlin",
			}),
		);
		expect(answer).toMatchObject({
			answer: "Mom slept seven hours.",
			followUps: ["Was that more than usual?"],
			model: "gemini-3.8-flash",
			urgent: false,
		});
		const sent = geminiCalls(it.calls, from);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ model: "gemini-3.8-flash", store: false });
		expect(JSON.stringify(sent[0].input)).toContain(question);
		// The web keeps asks for this session only; no member reads them back from the thread.
		expect(await thread(owner, path)).toEqual([]);
		expect(await thread(member, path)).toEqual([]);
	});

	// #187: each overloaded round goes to the fallback model, then both again after 1 s and 3 s.
	test("Gemini overloaded: AI on retries both models with backoff, then says it is busy", async () => {
		if (!it) return;
		it.providers.gemini = () =>
			Response.json({ error: { code: 503 } }, { status: 503 });
		const from = it.calls.length;
		const reply = await owner.call("POST", `${path}/ask`, {
			question: "Is Mom's heart rate normal?",
			timeZone: "Europe/Berlin",
		});
		expect(reply.status).toBe(502);
		const error = Schema.decodeUnknownSync(ApiError)(await reply.json());
		expect(error.error).toBe("upstream_error");
		expect(error.message).toContain("busy");
		expect(geminiCalls(it.calls, from).map((call) => call.model)).toEqual(
			Array.from({ length: 3 }, () => [
				"gemini-3.8-flash",
				"gemini-3.5-flash",
			]).flat(),
		);
		expect(await thread(member, path)).toEqual([]);
	});

	test("Family only: the message is stored without Gemini, once per clientId, and the member reads it", async () => {
		if (!it) return;
		const from = it.calls.length;
		const message = {
			clientId: crypto.randomUUID(),
			body: "I'll visit Mom at 5.",
		};
		const sent = await owner.call("POST", `${path}/messages`, message);
		expect(sent.status).toBe(201);
		const stored = await json(FamilyMessage, sent);
		expect(stored).toMatchObject({
			sender: owner.identity,
			body: message.body,
			clientId: message.clientId,
		});
		// The web resends with the same clientId after a lost reply; one copy stays.
		expect((await owner.call("POST", `${path}/messages`, message)).status).toBe(
			201,
		);
		expect(geminiCalls(it.calls, from)).toEqual([]);
		for (const reader of [member, owner])
			expect(await thread(reader, path)).toEqual([stored]);
	});
});
