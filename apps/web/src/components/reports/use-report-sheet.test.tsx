import "../test/setup";

import {
	afterEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";
import type { Report } from "@health/contracts/reports";
import type { ApiFailure } from "@/lib/api";
import {
	act,
	installDom,
	renderHook,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { formatTime } from "./logic";
import { failureText, useReportSheet } from "./use-report-sheet";

installDom();

afterEach(() => {
	setSystemTime();
});

const report = (over: Partial<Report> = {}): Report => ({
	id: "r/1",
	familyId: "1",
	createdBy: "me",
	createdAt: "2026-10-01T09:00:00.000Z",
	markers: [],
	meals: null,
	unresolved: null,
	fields: {
		patientName: "Ada",
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: null,
		observations: null,
		questions: null,
		corrections: [],
	},
	review: null,
	...over,
});

const BASE = "POST /api/families/1/reports/r%2F1";

const sheetOf = (value: Report, createFailure: ApiFailure | null = null) => {
	const onChanged = mock(() => {});
	const hook = renderHook(() =>
		useReportSheet(value, "1", onChanged, createFailure),
	);
	return { hook, onChanged };
};

describe("failureText", () => {
	test("asks a signed-out person to sign in again and shows other messages as sent", () => {
		expect(failureText({ kind: "signed_out" })).toBe("Sign in again.");
		expect(failureText({ kind: "forbidden", message: "Not a member." })).toBe(
			"Not a member.",
		);
	});
});

describe("useReportSheet", () => {
	test("starts as an unsaved draft with the report's fields in the form", () => {
		serve({});
		const { hook } = sheetOf(report());
		const sheet = hook.result.current;
		expect(sheet.reviewed).toBe(false);
		expect(sheet.draft.patientName).toBe("Ada");
		expect(sheet.dirty).toBe(false);
		expect(sheet.valid).toBe(true);
		expect(sheet.busy).toBeNull();
		expect(sheet.status).toBe("Draft · not sent");
	});

	test("shows the failure to create a report it was opened with", () => {
		serve({});
		const { hook } = sheetOf(report(), { kind: "signed_out" });
		expect(hook.result.current.status).toBe("Sign in again.");
	});

	test("shows a failure to create a report that happens while it is open", async () => {
		serve({ [`${BASE}/review`]: { status: 204 } });
		const value = report();
		const initialProps: { failure: ApiFailure | null } = { failure: null };
		const hook = renderHook(
			({ failure }) => useReportSheet(value, "1", () => {}, failure),
			{ initialProps },
		);
		expect(hook.result.current.status).toBe("Draft · not sent");
		hook.rerender({ failure: { kind: "error", message: "HTTP 500" } });
		expect(hook.result.current.status).toBe("HTTP 500");
		await act(() => hook.result.current.review());
		expect(hook.result.current.status).toBe("Draft · not sent");
		hook.rerender({ failure: { kind: "error", message: "HTTP 502" } });
		expect(hook.result.current.status).toBe("HTTP 502");
	});

	test("a reviewed report is read-only and says when it was reviewed", () => {
		serve({});
		const reviewedAt = "2026-10-02T10:00:00.000Z";
		const { hook } = sheetOf(
			report({ review: { reviewedBy: "me", reviewedAt } }),
		);
		expect(hook.result.current.reviewed).toBe(true);
		expect(hook.result.current.status).toBe(
			`Reviewed ${formatTime(reviewedAt)} · read-only · not sent`,
		);
	});

	test("an edit marks the draft unsaved, and a too-long field makes it invalid", () => {
		serve({});
		const { hook } = sheetOf(report());
		act(() =>
			hook.result.current.setDraft({
				...hook.result.current.draft,
				physician: "Dr. Who",
			}),
		);
		expect(hook.result.current.dirty).toBe(true);
		expect(hook.result.current.status).toBe("Draft · changes not saved");
		act(() =>
			hook.result.current.setDraft({
				...hook.result.current.draft,
				hospital: "x".repeat(201),
			}),
		);
		expect(hook.result.current.valid).toBe(false);
		expect(hook.result.current.errors.hospital).toBe(
			"Hospital is 201 characters. The limit is 200.",
		);
	});

	test("save sends the fields with empty boxes as null and stays busy until the reply", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({ [`${BASE}/fields`]: () => reply.promise });
		const { hook, onChanged } = sheetOf(report());
		act(() =>
			hook.result.current.setDraft({
				...hook.result.current.draft,
				physician: "  Dr. Who  ",
			}),
		);
		let saving = Promise.resolve();
		act(() => {
			saving = hook.result.current.save();
		});
		expect(hook.result.current.status).toBe("Saving…");
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => {
			reply.resolve({ status: 204 });
			await saving;
		});
		expect(calls[0]?.body).toEqual({
			patientName: "Ada",
			dateOfBirth: null,
			patientId: null,
			physician: "Dr. Who",
			hospital: null,
			notes: null,
			observations: null,
			questions: null,
			corrections: [],
		});
		expect(onChanged).toHaveBeenCalledTimes(1);
		// The report prop is still the old one until the parent reloads it.
		expect(hook.result.current.status).toBe("Draft · changes not saved");
		expect(hook.result.current.busy).toBeNull();
	});

	test("after a save of the saved fields, the status gives the save time", async () => {
		setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
		serve({ [`${BASE}/fields`]: { status: 204 } });
		const { hook, onChanged } = sheetOf(report());
		await act(() => hook.result.current.save());
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(hook.result.current.status).toBe(
			`Draft · saved ${formatTime(Date.parse("2026-10-03T12:00:00.000Z"))}`,
		);
	});

	test("a failed save keeps the draft and shows the server's reason", async () => {
		serve({
			[`${BASE}/fields`]: {
				status: 500,
				body: { error: "internal", message: "Database down." },
			},
		});
		const { hook, onChanged } = sheetOf(report());
		await act(() => hook.result.current.save());
		expect(onChanged).not.toHaveBeenCalled();
		expect(hook.result.current.status).toBe("Database down.");
	});

	test("review posts without a body and clears an earlier failure", async () => {
		let reply: ServerReply = {
			status: 500,
			body: { error: "internal", message: "Database down." },
		};
		const calls = serve({ [`${BASE}/review`]: () => reply });
		const { hook, onChanged } = sheetOf(report());
		await act(() => hook.result.current.review());
		expect(hook.result.current.status).toBe("Database down.");
		expect(onChanged).not.toHaveBeenCalled();
		reply = { status: 204 };
		await act(() => hook.result.current.review());
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(hook.result.current.status).toBe("Draft · not sent");
		expect(calls.map((call) => call.body)).toEqual([undefined, undefined]);
	});

	test("a 401 to review ends the session, so a later review is not sent", async () => {
		const calls = serve({ [`${BASE}/review`]: { status: 401 } });
		const { hook, onChanged } = sheetOf(report());
		await act(() => hook.result.current.review());
		expect(hook.result.current.status).toBe("Sign in again.");
		await act(() => hook.result.current.review());
		expect(hook.result.current.status).toBe("Sign in again.");
		expect(calls).toHaveLength(1);
		expect(onChanged).not.toHaveBeenCalled();
	});

	test("a success reply to submit is still not a delivery receipt", async () => {
		const calls = serve({ [`${BASE}/submit`]: { status: 204 } });
		const { hook } = sheetOf(report());
		let sending = Promise.resolve();
		act(() => {
			sending = hook.result.current.submit();
		});
		expect(hook.result.current.status).toBe("Sending…");
		await act(() => sending);
		expect(calls).toHaveLength(1);
		expect(hook.result.current.sendFailure).toEqual({
			kind: "error",
			message: "The server replied, but gave no delivery receipt.",
		});
		expect(hook.result.current.status).toBe(
			"The server replied, but gave no delivery receipt.",
		);
	});

	test("an unavailable delivery path is kept as the send failure", async () => {
		serve({
			[`${BASE}/submit`]: {
				status: 503,
				body: { error: "unavailable", message: "Hospital delivery is off." },
			},
		});
		const { hook } = sheetOf(report());
		await act(() => hook.result.current.submit());
		expect(hook.result.current.sendFailure).toEqual({
			kind: "unavailable",
			message: "Hospital delivery is off.",
		});
	});

	test("the review confirmation box starts unticked and can be ticked", () => {
		serve({});
		const { hook } = sheetOf(report());
		expect(hook.result.current.confirmed).toBe(false);
		act(() => hook.result.current.setConfirmed(true));
		expect(hook.result.current.confirmed).toBe(true);
	});
});
