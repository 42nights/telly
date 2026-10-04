import { afterEach, describe, expect, jest, test } from "bun:test";

import {
	arCapabilities,
	CAPABILITIES_TIMEOUT_MS,
	findPin,
	savePin,
} from "./ar-bridge";

type Sent = { type: string; requestId: string } & Record<string, unknown>;

/** A fake iOS shell: records each request and answers with `answer`'s replies, like web.tsx does. */
const fakeShell = (answer: (request: Sent) => unknown[]) => {
	const sent: Sent[] = [];
	globalThis.ReactNativeWebView = {
		postMessage: (data) => {
			const request = JSON.parse(data) as Sent;
			sent.push(request);
			for (const detail of answer(request))
				queueMicrotask(() =>
					globalThis.dispatchEvent(new CustomEvent("telly-ar", { detail })),
				);
		},
	};
	return sent;
};

afterEach(() => {
	globalThis.ReactNativeWebView = undefined;
	jest.useRealTimers();
});

describe("ar bridge", () => {
	test("outside the iOS shell, AR is unsupported and nothing is sent", async () => {
		expect(await arCapabilities()).toEqual({
			supported: false,
			reason: "not-ios",
		});
	});

	test("matches the reply by requestId and ignores other and malformed replies", async () => {
		const sent = fakeShell(({ requestId }) => [
			{ type: "ar.capabilities", requestId: "someone-else", supported: false },
			{ type: "ar.capabilities", requestId, supported: "yes" },
			{ type: "ar.capabilities", requestId, supported: true },
		]);
		expect(await arCapabilities()).toEqual({ supported: true });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe("ar.capabilities");
	});

	test("passes the reason when the shell says AR is not supported", async () => {
		fakeShell(({ requestId }) => [
			{
				type: "ar.capabilities",
				requestId,
				supported: false,
				reason: "no-arkit",
			},
		]);
		expect(await arCapabilities()).toEqual({
			supported: false,
			reason: "no-arkit",
		});
	});

	test("a shell that never answers means unsupported after the timeout", async () => {
		jest.useFakeTimers();
		fakeShell(() => []);
		const answer = arCapabilities();
		jest.advanceTimersByTime(CAPABILITIES_TIMEOUT_MS);
		expect(await answer).toEqual({ supported: false });
	});

	// A shell built before #301 reads and echoes `containerId`; a newer one uses `objectId`.
	test.each(["containerId", "objectId"])(
		"savePin works with a shell that reads the id as %s",
		async (field) => {
			const sent = fakeShell((request) => [
				{
					type: "ar.pinSaved",
					requestId: request.requestId,
					[field]: request[field],
					anchorId: `telly-pin-${request[field]}`,
					worldMap: "bWFw",
					mapBytes: 3,
				},
			]);
			expect(
				await savePin({
					familyId: "1",
					objectId: "7",
					label: "Lisinopril",
					session: "s",
					others: [],
				}),
			).toEqual({
				kind: "saved",
				anchorId: "telly-pin-7",
				worldMap: "bWFw",
				mapBytes: 3,
				// Shells built before #351 list no pins of the map.
				anchors: [],
			});
			expect(sent[0]).toMatchObject({
				type: "ar.savePin",
				familyId: "1",
				objectId: "7",
				containerId: "7",
				label: "Lisinopril",
			});
		},
	);

	test("findPin returns the shell's error code", async () => {
		fakeShell(({ requestId }) => [
			{
				type: "ar.error",
				requestId,
				code: "relocalization-failed",
				message: "not relocalized",
			},
		]);
		expect(
			await findPin({
				objectId: "7",
				label: "Lisinopril",
				anchorId: "telly-pin-7",
				worldMap: "bWFw",
				session: "s",
				others: [],
			}),
		).toEqual({
			kind: "error",
			code: "relocalization-failed",
			message: "not relocalized",
		});
	});

	test("a reply of the wrong type for the request is a failure", async () => {
		fakeShell(({ requestId }) => [
			{ type: "ar.pinFound", requestId, objectId: "7" },
		]);
		const saved = await savePin({
			familyId: "1",
			objectId: "7",
			label: "Lisinopril",
			session: "s",
			others: [],
		});
		expect(saved).toMatchObject({ kind: "error", code: "failed" });
	});
});
