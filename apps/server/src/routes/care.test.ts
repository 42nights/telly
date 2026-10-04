// Runs the family contact ladder (issue #30) in the real app against a real local SpacetimeDB
// (`bun run db:test`). Ladder deadlines are database timers, so the test waits them out. Every
// person is a synthetic test identity; calls are simulated and nothing leaves the database.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, Family } from "@health/contracts";
import {
	CareNeed,
	CareNeeds,
	type ContactLadderInput,
	ContactLadderReply,
} from "@health/contracts/care";
import { FamilyMessages } from "@health/contracts/chat";
import { Me } from "@health/contracts/families";
import { Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";

const uri = process.env.SPACETIMEDB_URI;
const database = process.env.SPACETIMEDB_DATABASE;
const audience = "telly-test";

const pair = await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
);
const jwk = { kid: "care-test", alg: "RS256" };
const publicKey = {
	...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
	...jwk,
};
const privateKey = {
	...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
	...jwk,
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
		if (pathname === "/jwks") return Response.json({ keys: [publicKey] });
		return new Response(null, { status: 404 });
	},
});
const issuer = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

const now = () => Math.floor(Date.now() / 1000);
const token = (subject: string) =>
	sign(
		{ iss: issuer, sub: subject, aud: audience, iat: now(), exp: now() + 600 },
		privateKey,
		"RS256",
	);

const app =
	uri && database
		? createApp({
				corsOrigin: "http://localhost:3001",
				auth: { issuer, audience, db: { uri, database } },
				voice: {
					apiKey: undefined,
					voiceId: "unused",
					baseUrl: "http://127.0.0.1:1",
				},
			})
		: undefined;

const call = async (
	subject: string,
	method: string,
	path: string,
	body?: unknown,
) => {
	if (app === undefined)
		throw new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE are unset");
	return app.request(path, {
		method,
		headers: {
			Authorization: `Bearer ${await token(subject)}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
};
const json = async <T>(schema: Schema.Decoder<T>, response: Response) => {
	expect(response.status).toBeLessThan(300);
	return Schema.decodeUnknownSync(schema)(await response.json());
};
const errorOf = async (response: Response) =>
	[
		response.status,
		Schema.decodeUnknownSync(ApiError)(await response.json()).error,
	] as const;
const identityOf = async (subject: string) =>
	(await json(Me, await call(subject, "GET", "/api/me"))).identity;
/**
 * Re-reads the need until `done` holds. The ladder's deadlines are SpacetimeDB scheduled reducers on
 * the database's own clock, which a test cannot fake, so this waits for the real timer to fire.
 */
const until = async (
	subject: string,
	path: string,
	done: (need: CareNeed) => boolean,
) => {
	const deadline = Date.now() + WAIT;
	for (;;) {
		const need = await json(CareNeed, await call(subject, "GET", path));
		if (done(need) || Date.now() > deadline) return need;
		await Bun.sleep(250);
	}
};

/** A family of `owner` plus the other subjects as members; returns its path and their identities. */
const newFamily = async (owner: string, ...members: string[]) => {
	const family = await json(
		Family,
		await call(owner, "POST", "/api/families", { name: "Rivera" }),
	);
	const path = `/api/families/${family.id}`;
	for (const member of members) {
		const added = await call(owner, "POST", `${path}/members`, {
			identity: await identityOf(member),
		});
		expect(added.status).toBe(204);
	}
	return path;
};

const contact = async (
	subject: string,
	name: string,
	detail: "minimal" | "summary" | "facts",
	callFor: ("alert" | "help" | "call_reminder")[],
) => ({
	member: await identityOf(subject),
	name,
	timeZone: "Asia/Kolkata",
	detail,
	callFor,
});

const ANSWER = 10;
const WAIT = (ANSWER + 3) * 1000;

describe.skipIf(app === undefined)("family contact ladder", () => {
	test(
		"primary no-answer, backup accepts, help confirmed; repeats and outsiders change nothing",
		async () => {
			const [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map(
				(name) => `${name}-${crypto.randomUUID()}`,
			) as [string, string, string, string];
			const path = await newFamily(alice, bob, carol);
			const ladder: ContactLadderInput = {
				contacts: [await contact(bob, "Bob", "facts", ["help"])],
				backup: await contact(carol, "Carol", "summary", []),
				answerSeconds: ANSWER,
				followUpSeconds: 600,
			};

			expect(
				await json(
					ContactLadderReply,
					await call(alice, "GET", `${path}/care/ladder`),
				),
			).toEqual({ ladder: null });
			// Only family members can be contacts, and outsiders cannot set the ladder.
			expect(
				await errorOf(
					await call(alice, "PUT", `${path}/care/ladder`, {
						...ladder,
						backup: await contact(dave, "Dave", "facts", []),
					}),
				),
			).toEqual([400, "invalid_request"]);
			expect(
				await errorOf(await call(dave, "PUT", `${path}/care/ladder`, ladder)),
			).toEqual([403, "forbidden"]);
			expect(
				await errorOf(
					await call(alice, "PUT", `${path}/care/ladder`, {
						...ladder,
						backup: { ...ladder.backup, timeZone: "Mars/Olympus" },
					}),
				),
			).toEqual([400, "invalid_request"]);
			expect(
				(await call(alice, "PUT", `${path}/care/ladder`, ladder)).status,
			).toBe(200);
			// Every member reads the ladder as set.
			const { ladder: saved } = await json(
				ContactLadderReply,
				await call(bob, "GET", `${path}/care/ladder`),
			);
			expect(saved).toMatchObject(ladder);

			const sample = (await (
				await call(alice, "POST", `${path}/samples`, {
					metric: "heart_rate",
					value: 128,
					unit: "bpm",
					sourceTime: new Date().toISOString(),
					source: "synthetic-demo",
					synthetic: true,
					quality: "validated",
				})
			).json()) as { id: string };
			const ask = {
				clientId: "help-1",
				kind: "help",
				summary: "Grandma asked for help with her evening medicine",
				sampleIds: [sample.id],
				dueAt: null,
			};
			const opened = await json(
				CareNeed,
				await call(alice, "POST", `${path}/care/needs`, ask),
			);
			// A resend after a lost reply stores and calls nothing new.
			const resent = await json(
				CareNeed,
				await call(alice, "POST", `${path}/care/needs`, ask),
			);
			expect(resent.id).toBe(opened.id);
			expect(opened.status).toBe("open");
			expect(opened.remaining).toEqual(["Carol"]);
			const [toBob] = opened.attempts;
			expect(toBob).toMatchObject({
				name: "Bob",
				channel: "call",
				status: "sent",
			});
			// Bob may see the facts with their source, time, and uncertainty.
			expect(toBob?.body).toContain("heart_rate 128 bpm (synthetic-demo,");
			expect(toBob?.body).toContain("synthetic demo data, validated signal");
			expect(toBob?.contactLocalTime).toContain("(Asia/Kolkata)");

			const need = `${path}/care/needs/${opened.id}`;
			const respond = (subject: string, response: string) =>
				call(subject, "POST", `${need}/responses`, { response });
			expect(await errorOf(await respond(carol, "accept"))).toEqual([
				403,
				"forbidden",
			]);
			expect(await errorOf(await respond(dave, "accept"))).toEqual([
				403,
				"forbidden",
			]);
			expect(
				await errorOf(await call(dave, "GET", `${path}/care/needs`)),
			).toEqual([403, "forbidden"]);
			expect(await errorOf(await respond(alice, "help_confirmed"))).toEqual([
				403,
				"forbidden",
			]);

			// Bob does not answer; the database moves to the backup on its own timer.
			const moved = await until(alice, need, (n) => n.attempts.length === 2);
			expect(moved.status).toBe("open");
			expect(moved.attempts.map((a) => [a.name, a.status, a.backup])).toEqual([
				["Bob", "no_answer", false],
				["Carol", "sent", true],
			]);
			// Carol may see the summary but not the facts.
			expect(moved.attempts[1]?.body).toContain(ask.summary);
			expect(moved.attempts[1]?.body).not.toContain("heart_rate");
			expect(await errorOf(await respond(bob, "accept"))).toEqual([
				403,
				"forbidden",
			]);
			expect(await errorOf(await respond(carol, "answer"))).toEqual([
				400,
				"invalid_request",
			]);

			expect((await respond(carol, "seen")).status).toBe(200);
			const accepted = await json(CareNeed, await respond(carol, "accept"));
			expect(accepted.status).toBe("accepted");
			expect(accepted.acceptedBy).toBe(await identityOf(carol));
			expect(accepted.followUpBy).not.toBeNull();
			const again = await json(CareNeed, await respond(carol, "accept"));
			expect(again.attempts).toEqual(accepted.attempts);

			const resolved = await json(
				CareNeed,
				await respond(carol, "help_confirmed"),
			);
			expect(resolved.status).toBe("resolved");
			expect(resolved.attempts.map((a) => a.status)).toEqual([
				"no_answer",
				"accepted",
			]);

			// Both family clients read the same state.
			const forBob = await json(
				CareNeeds,
				await call(bob, "GET", `${path}/care/needs`),
			);
			expect(forBob.needs).toEqual([resolved]);
			const chat = await json(
				FamilyMessages,
				await call(bob, "GET", `${path}/messages`),
			);
			expect(chat.messages.map((m) => m.body)).toEqual([
				expect.stringContaining("Calling (simulated) Bob"),
				expect.stringContaining("Message for Carol"),
				expect.stringContaining("Carol accepted"),
				expect.stringContaining("Carol confirmed help"),
			]);
			// The family chat never carries the facts.
			expect(chat.messages.some((m) => m.body.includes("heart_rate"))).toBe(
				false,
			);
		},
		WAIT + 20_000,
	);

	test(
		"an accepted alert stops repeat contacts until its follow-up expires, then stays unresolved",
		async () => {
			const alice = `alice-${crypto.randomUUID()}`;
			const bob = `bob-${crypto.randomUUID()}`;
			const path = await newFamily(alice, bob);
			expect(
				(
					await call(alice, "PUT", `${path}/care/ladder`, {
						contacts: [await contact(bob, "Bob", "minimal", [])],
						backup: null,
						answerSeconds: 600,
						followUpSeconds: ANSWER,
					})
				).status,
			).toBe(200);
			expect(
				(
					await call(alice, "PUT", `${path}/alert-thresholds`, {
						metric: "heart_rate",
						direction: "above",
						limit: 120,
						unit: "bpm",
						maxAgeSeconds: 600,
					})
				).status,
			).toBe(200);
			const breach = (offset: number) =>
				call(alice, "POST", `${path}/samples`, {
					metric: "heart_rate",
					value: 130 + offset,
					unit: "bpm",
					sourceTime: new Date(Date.now() - offset * 1000).toISOString(),
					source: "synthetic-demo",
					synthetic: true,
					quality: "validated",
				});
			expect((await breach(0)).status).toBe(201);
			const [opened] = (
				await json(CareNeeds, await call(alice, "GET", `${path}/care/needs`))
			).needs;
			expect(opened).toMatchObject({ kind: "alert", status: "open" });
			expect(opened?.alertId).not.toBeNull();
			const [toBob] = opened?.attempts ?? [];
			expect(toBob).toMatchObject({ channel: "message", status: "sent" });
			// Minimal detail: that a need exists, not what it is.
			expect(toBob?.body).not.toContain("heart_rate");

			const need = `${path}/care/needs/${opened?.id}`;
			expect(
				(await call(bob, "POST", `${need}/responses`, { response: "accept" }))
					.status,
			).toBe(200);
			// A second alert adds its facts to the accepted need and contacts nobody.
			expect((await breach(1)).status).toBe(201);
			const after = await json(
				CareNeeds,
				await call(alice, "GET", `${path}/care/needs`),
			);
			expect(after.needs).toHaveLength(1);
			expect(after.needs[0]?.facts).toHaveLength(2);
			expect(after.needs[0]?.attempts).toHaveLength(1);

			const expired = await until(alice, need, (n) => n.status !== "accepted");
			expect(expired.status).toBe("unresolved");
			expect(expired.attempts.map((a) => a.status)).toEqual([
				"follow_up_expired",
			]);
			expect(
				await errorOf(
					await call(bob, "POST", `${need}/responses`, {
						response: "help_confirmed",
					}),
				),
			).toEqual([403, "forbidden"]);
		},
		WAIT + 20_000,
	);
});
