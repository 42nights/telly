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
	}),
	findPin: async () => ({ type: "ar.pinFound" }),
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
