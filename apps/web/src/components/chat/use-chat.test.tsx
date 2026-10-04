// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, spyOn, test } from "bun:test";
import type { FamilyMessage } from "@health/contracts";

import { setSessionToken } from "@/lib/session";

import {
	renderHook,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom-routed";
import { useChat } from "./use-chat";

setupDom();

const PATH = "/api/families/f1/messages";

const message = (id: string): FamilyMessage => ({
	id,
	familyId: "f1",
	sender: "alice",
	body: `Message ${id}`,
	sentAt: "2026-10-04T10:00:00.000Z",
	clientId: `c${id}`,
});

/** A token with an issuer and subject, so the pending queue knows who owns a send. */
const OWNER_TOKEN = `h.${Buffer.from(JSON.stringify({ iss: "https://id.test", sub: "alice", exp: 4e9 })).toString("base64url")}.s`;

const ids = (messages: readonly FamilyMessage[]) => messages.map((m) => m.id);

test("reads the messages, then refresh asks only for the ones after the newest", async () => {
	signIn();
	const calls = serve({
		[`GET ${PATH}`]: { json: { messages: [message("1"), message("2")] } },
		[`GET ${PATH}?after=2`]: { json: { messages: [message("3")] } },
	});
	const { result } = renderHook(() => useChat("f1"));
	expect(result.current.read).toEqual({ kind: "loading" });
	await waitFor(() => expect(result.current.read).toEqual({ kind: "ready" }));
	expect(ids(result.current.messages)).toEqual(["1", "2"]);

	result.current.refresh();
	await waitFor(() =>
		expect(ids(result.current.messages)).toEqual(["1", "2", "3"]),
	);
	expect(calls.map((call) => call.path)).toEqual([PATH, `${PATH}?after=2`]);
});

test("a full page of 200 messages makes it read the next page at once", async () => {
	signIn();
	const full = Array.from({ length: 200 }, (_, i) => message(String(i + 1)));
	const calls = serve({
		[`GET ${PATH}`]: { json: { messages: full } },
		[`GET ${PATH}?after=200`]: { json: { messages: [message("201")] } },
	});
	const { result } = renderHook(() => useChat("f1"));
	await waitFor(() => expect(result.current.messages).toHaveLength(201));
	expect(calls.map((call) => call.path)).toEqual([PATH, `${PATH}?after=200`]);
});

test("an empty thread is ready, and a failed read keeps its meaning", async () => {
	signIn();
	serve({ [`GET ${PATH}`]: { json: { messages: [] } } });
	const empty = renderHook(() => useChat("f1"));
	await waitFor(() =>
		expect(empty.result.current.read).toEqual({ kind: "ready" }),
	);
	expect(empty.result.current.messages).toEqual([]);

	serve({
		[`GET ${PATH}`]: {
			status: 403,
			json: { error: "forbidden", message: "Not a member" },
		},
	});
	const refused = renderHook(() => useChat("f1"));
	await waitFor(() =>
		expect(refused.result.current.read).toEqual({
			kind: "forbidden",
			message: "Not a member",
		}),
	);
});

test("unmounting stops a read in flight without an error", async () => {
	signIn();
	const calls = serve({ [`GET ${PATH}`]: "hang" });
	const { result, unmount } = renderHook(() => useChat("f1"));
	await waitFor(() => expect(calls).toHaveLength(1));
	unmount();
	await Bun.sleep(0);
	expect(result.current.read).toEqual({ kind: "loading" });
	expect(calls).toHaveLength(1);
});

test("a sent message is posted with a client id and the thread catches up", async () => {
	setSessionToken(OWNER_TOKEN);
	const calls = serve({
		[`GET ${PATH}`]: { json: { messages: [message("1")] } },
		[`POST ${PATH}`]: { status: 201, json: message("2") },
		[`GET ${PATH}?after=1`]: { json: { messages: [message("2")] } },
	});
	const { result } = renderHook(() => useChat("f1"));
	await waitFor(() => expect(result.current.read).toEqual({ kind: "ready" }));

	expect(await result.current.send("On my way")).toEqual({ kind: "sent" });
	const post = calls.find((call) => call.method === "POST");
	expect(post?.body).toEqual({
		body: "On my way",
		clientId: expect.any(String),
	});
	await waitFor(() => expect(ids(result.current.messages)).toEqual(["1", "2"]));
});

test("a refused message is reported and not stored", async () => {
	setSessionToken(OWNER_TOKEN);
	const errors = spyOn(console, "error").mockImplementation(() => {});
	serve({
		[`GET ${PATH}`]: { json: { messages: [] } },
		[`POST ${PATH}`]: {
			status: 400,
			json: { error: "invalid_request", message: "Too long" },
		},
	});
	const { result } = renderHook(() => useChat("f1"));
	await waitFor(() => expect(result.current.read).toEqual({ kind: "ready" }));
	expect(await result.current.send("x")).toEqual({
		kind: "rejected",
		message: "Too long",
	});
	expect(errors).toHaveBeenCalledWith("Family message not stored yet:", {
		kind: "rejected",
		message: "Too long",
	});
	errors.mockRestore();
});

test("transcribe posts the raw recording with its type and decodes the words", async () => {
	signIn();
	const transcript = {
		text: "hello",
		languageCode: "en",
		languageProbability: 0.9,
	};
	const calls = serve({
		[`GET ${PATH}`]: { json: { messages: [] } },
		"POST /api/families/f1/voice/transcriptions": { json: transcript },
	});
	const { result } = renderHook(() => useChat("f1"));
	await waitFor(() => expect(result.current.read).toEqual({ kind: "ready" }));
	const audio = new Blob(["abc"], { type: "audio/webm" });
	expect(await result.current.transcribe(audio)).toEqual({
		kind: "ready",
		value: transcript,
	});
	const post = calls.find((call) => call.method === "POST");
	expect(post?.path).toBe("/api/families/f1/voice/transcriptions");
	expect(post?.body).toBe(audio);
});
