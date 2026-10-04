/// <reference types="bun" />

import { expect, test } from "bun:test";

import type { TellyArModule } from "@/modules/telly-ar";

import { answerArRequest } from "./ar-bridge";

const fake = (overrides: Partial<TellyArModule>): TellyArModule => ({
	capabilities: async () => ({ supported: true }),
	savePin: async () => ({
		type: "ar.pinSaved",
		anchorId: "A",
		worldMap: "bWFw",
		mapBytes: 3,
		anchors: [{ objectId: "c1", anchorId: "A" }],
	}),
	findPin: async () => ({ type: "ar.pinFound" }),
	watch: async () => ({ type: "ar.closed" }),
	...overrides,
});

const save = {
	type: "ar.savePin",
	requestId: "r1",
	familyId: "f1",
	objectId: "c1",
	label: "Aspirin",
} as const;

test("capabilities says why AR is missing without the native module", async () => {
	const ask = { type: "ar.capabilities", requestId: "r0" } as const;
	expect(await answerArRequest(ask, null, "android")).toEqual({
		type: "ar.capabilities",
		requestId: "r0",
		supported: false,
		reason: "not-ios",
	});
	expect(await answerArRequest(ask, null, "ios")).toMatchObject({
		supported: false,
		reason: "no-arkit",
	});
	expect(await answerArRequest(ask, fake({}), "ios")).toEqual({
		type: "ar.capabilities",
		requestId: "r0",
		supported: true,
	});
});

test("save and find answers carry the requestId and objectId", async () => {
	expect(await answerArRequest(save, fake({}), "ios")).toEqual({
		type: "ar.pinSaved",
		requestId: "r1",
		objectId: "c1",
		anchorId: "A",
		worldMap: "bWFw",
		mapBytes: 3,
		anchors: [{ objectId: "c1", anchorId: "A" }],
	});
	const find = {
		type: "ar.findPin",
		requestId: "r2",
		objectId: "c1",
		label: "Aspirin",
		anchorId: "A",
		worldMap: "bWFw",
	} as const;
	expect(await answerArRequest(find, fake({}), "ios")).toEqual({
		type: "ar.pinFound",
		requestId: "r2",
		objectId: "c1",
	});
});

test("a web app from before #351 opens AR without a session, other pins, or a room map", async () => {
	const calls: unknown[][] = [];
	const native = fake({
		savePin: async (...args) => {
			calls.push(args);
			return { type: "ar.error", code: "cancelled", message: "closed" };
		},
	});
	await answerArRequest(save, native, "ios");
	expect(calls).toEqual([["c1", "Aspirin", null, [], null]]);
});

test("watch passes the session and the check answer, and returns the screen's message", async () => {
	const calls: unknown[][] = [];
	const native = fake({
		watch: async (...args) => {
			calls.push(args);
			return { type: "ar.moved", checkId: "c", objectIds: ["k"] };
		},
	});
	const answer = { checkId: "c", found: [{ objectId: "k", x: 1, y: 2 }] };
	expect(
		await answerArRequest(
			{ type: "ar.watch", requestId: "r3", session: "s", answer },
			native,
			"ios",
		),
	).toEqual({
		type: "ar.moved",
		requestId: "r3",
		checkId: "c",
		objectIds: ["k"],
	});
	await answerArRequest(
		{ type: "ar.watch", requestId: "r4", session: "s" },
		native,
		"ios",
	);
	expect(calls).toEqual([
		["s", answer],
		["s", null],
	]);
});

test("native errors keep their code, and a throw becomes failed", async () => {
	const cancelled = fake({
		savePin: async () => ({
			type: "ar.error",
			code: "cancelled",
			message: "closed",
		}),
	});
	expect(await answerArRequest(save, cancelled, "ios")).toEqual({
		type: "ar.error",
		requestId: "r1",
		code: "cancelled",
		message: "closed",
	});
	const broken = fake({
		savePin: async () => {
			throw new Error("boom");
		},
	});
	expect(await answerArRequest(save, broken, "ios")).toMatchObject({
		type: "ar.error",
		requestId: "r1",
		code: "failed",
	});
	expect(await answerArRequest(save, null, "android")).toMatchObject({
		type: "ar.error",
		code: "failed",
	});
});
