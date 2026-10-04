// Runs the mounted trip routes in the real app against a real local SpacetimeDB (`bun run db:test`).
// The OIDC issuer is a test-only server on 127.0.0.1 with a key made for this run.
import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, Family } from "@health/contracts";
import { FamilyMessages } from "@health/contracts/chat";
import { Me } from "@health/contracts/families";
import { CurrentTrip, TripCheckIn, TripReply } from "@health/contracts/trips";
import { Schema } from "effect";
import { sign } from "hono/jwt";
import { createApp } from "../app";
import { essentials } from "./trips";

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
const jwk = { kid: "trips-test", alg: "RS256" };
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
const read = async <T>(
	schema: Schema.Decoder<T>,
	response: Promise<Response>,
) => {
	const reply = await response;
	expect(reply.status).toBe(200);
	return Schema.decodeUnknownSync(schema)(await reply.json());
};
const errorOf = async (response: Response) =>
	[
		response.status,
		Schema.decodeUnknownSync(ApiError)(await response.json()).error,
	] as const;

const newFamily = async (subject: string) => {
	const created = await call(subject, "POST", "/api/families", {
		name: "Rivera",
	});
	return `/api/families/${Schema.decodeUnknownSync(Family)(await created.json()).id}`;
};

test("essentials follow the purpose and a low battery only", () => {
	expect(essentials("groceries", null)).toEqual(["keys", "phone"]);
	expect(essentials("Doctor at 3", 0.8)).toEqual([
		"keys",
		"phone",
		"appointment letter",
		"medicine list",
	]);
	expect(essentials("walk", 0.25)).toEqual([
		"keys",
		"phone",
		"phone charger (battery at 25%)",
	]);
	expect(essentials("walk", 0.3)).toEqual(["keys", "phone"]);
});

describe.skipIf(app === undefined)("leaving-home check-in routes", () => {
	test("one trip asks once, keeps every plan, and sends only the chosen notices", async () => {
		const wearer = `wearer-${crypto.randomUUID()}`;
		const daughter = `daughter-${crypto.randomUUID()}`;
		const path = await newFamily(wearer);
		const daughterMe = Schema.decodeUnknownSync(Me)(
			await (await call(daughter, "GET", "/api/me")).json(),
		);
		await call(wearer, "POST", `${path}/members`, {
			identity: daughterMe.identity,
		});
		expect(
			await read(CurrentTrip, call(wearer, "GET", `${path}/trips/current`)),
		).toEqual({ trip: null });

		const asked = await read(
			TripCheckIn,
			call(wearer, "POST", `${path}/trips/check-in`, {
				source: "departure_signal",
			}),
		);
		expect(asked).toMatchObject({
			asked: true,
			question: "Are you heading out now?",
			trip: { status: "asked", source: "departure_signal", plan: null },
		});
		const trip = `${path}/trips/${asked.trip.id}`;

		// The door sensor fires again while the question is open: nothing new is asked.
		expect(
			await read(
				TripCheckIn,
				call(wearer, "POST", `${path}/trips/check-in`, {
					source: "departure_signal",
				}),
			),
		).toMatchObject({ asked: false, trip: { id: asked.trip.id } });

		const left = await read(
			TripReply,
			call(wearer, "POST", `${trip}/answer`, {
				answer: "leaving",
				purpose: "Doctor appointment",
				destination: "Elm Street Clinic",
				notify: { departure: true, arrival: true },
				battery: 0.2,
			}),
		);
		expect(left.essentials).toEqual([
			"keys",
			"phone",
			"appointment letter",
			"medicine list",
			"phone charger (battery at 20%)",
		]);
		expect(left.prompt).toBe(
			"Before you go, check: keys, phone, appointment letter, medicine list, phone charger (battery at 20%).",
		);

		// Plans change: the later plan wins, the earlier one stays in the history.
		const changed = await read(
			TripReply,
			call(wearer, "POST", `${trip}/answer`, {
				answer: "leaving",
				purpose: "Pharmacy pickup",
				destination: null,
				notify: { departure: true, arrival: true },
				battery: null,
			}),
		);
		expect(changed.trip.plan).toMatchObject({
			purpose: "Pharmacy pickup",
			destination: null,
		});
		expect(changed.trip.events.map((e) => [e.step, e.purpose])).toEqual([
			["asked", null],
			["leaving", "Doctor appointment"],
			["leaving", "Pharmacy pickup"],
		]);

		// Boundary events during the trip ask nothing and notify nobody.
		for (const source of ["departure_signal", "manual"])
			expect(
				await read(
					TripCheckIn,
					call(wearer, "POST", `${path}/trips/check-in`, { source }),
				),
			).toMatchObject({ asked: false, trip: { id: asked.trip.id } });

		const arrived = await read(
			TripReply,
			call(wearer, "POST", `${trip}/answer`, { answer: "arrived" }),
		);
		expect(arrived).toMatchObject({
			trip: { status: "arrived" },
			essentials: [],
			prompt: null,
		});
		// A resend of the same answer records nothing new.
		await read(
			TripReply,
			call(wearer, "POST", `${trip}/answer`, { answer: "arrived" }),
		);

		const messages = await read(
			FamilyMessages,
			call(daughter, "GET", `${path}/messages`),
		);
		expect(messages.messages.map((m) => m.body)).toEqual([
			"I'm leaving home: Doctor appointment (Elm Street Clinic).",
			"I arrived: Pharmacy pickup.",
		]);
		expect(
			await read(CurrentTrip, call(daughter, "GET", `${path}/trips/current`)),
		).toMatchObject({ trip: { id: asked.trip.id, status: "arrived" } });

		const stranger = `stranger-${crypto.randomUUID()}`;
		expect(
			await errorOf(await call(stranger, "GET", `${path}/trips/current`)),
		).toEqual([403, "forbidden"]);
	});

	test("cancel and decline send nothing; a repeated signal waits, a manual request asks", async () => {
		const wearer = `wearer-${crypto.randomUUID()}`;
		const path = await newFamily(wearer);
		const first = await read(
			TripCheckIn,
			call(wearer, "POST", `${path}/trips/check-in`, { source: "manual" }),
		);
		await read(
			TripReply,
			call(wearer, "POST", `${path}/trips/${first.trip.id}/answer`, {
				answer: "leaving",
				purpose: "Walk",
				destination: null,
				notify: { departure: false, arrival: false },
				battery: null,
			}),
		);
		expect(
			await read(
				TripReply,
				call(wearer, "POST", `${path}/trips/${first.trip.id}/answer`, {
					answer: "cancel",
				}),
			),
		).toMatchObject({
			trip: { status: "cancelled", plan: { purpose: "Walk" } },
		});
		expect(
			await errorOf(
				await call(wearer, "POST", `${path}/trips/${first.trip.id}/answer`, {
					answer: "arrived",
				}),
			),
		).toEqual([400, "invalid_request"]);

		expect(
			await read(
				TripCheckIn,
				call(wearer, "POST", `${path}/trips/check-in`, {
					source: "departure_signal",
				}),
			),
		).toMatchObject({ asked: false, trip: { id: first.trip.id } });
		const second = await read(
			TripCheckIn,
			call(wearer, "POST", `${path}/trips/check-in`, { source: "manual" }),
		);
		expect(second).toMatchObject({ asked: true, trip: { status: "asked" } });
		expect(second.trip.id).not.toBe(first.trip.id);

		expect(
			await read(FamilyMessages, call(wearer, "GET", `${path}/messages`)),
		).toEqual({ messages: [] });
		expect(
			await errorOf(
				await call(wearer, "POST", `${path}/trips/nope/answer`, {
					answer: "cancel",
				}),
			),
		).toEqual([404, "not_found"]);
		for (const body of [
			{
				answer: "leaving",
				purpose: " ",
				destination: null,
				notify: { departure: false, arrival: false },
				battery: null,
			},
			{
				answer: "leaving",
				purpose: "Walk",
				destination: null,
				notify: { departure: false, arrival: false },
				battery: 2,
			},
			{
				answer: "leaving",
				purpose: "Walk",
				destination: null,
				notify: { departure: false, arrival: false },
				battery: null,
				location: "home",
			},
		])
			expect(
				await errorOf(
					await call(
						wearer,
						"POST",
						`${path}/trips/${second.trip.id}/answer`,
						body,
					),
				),
			).toEqual([400, "invalid_request"]);
	});
});
