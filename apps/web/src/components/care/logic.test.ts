import { describe, expect, test } from "bun:test";
import type { CareNeed, ContactAttempt } from "@health/contracts/care";

import { actionsFor } from "./logic";

const attempt = (
	member: string,
	status: ContactAttempt["status"],
	channel: ContactAttempt["channel"] = "message",
): ContactAttempt => ({
	step: 0,
	member,
	name: member,
	backup: false,
	channel,
	status,
	body: "",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	contactLocalTime: "",
});

const need = (
	status: CareNeed["status"],
	attempts: ContactAttempt[],
	acceptedBy: string | null = null,
): CareNeed => ({
	id: "1",
	familyId: "1",
	kind: "help",
	summary: "",
	facts: [],
	alertId: null,
	dueAt: "2026-01-01T00:00:00Z",
	status,
	acceptedBy,
	followUpBy: null,
	raisedBy: "a",
	clientId: "c",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	attempts,
	remaining: [],
});

describe("actionsFor", () => {
	test("only the current contact answers, and a call can be answered once", () => {
		const ringing = need("open", [
			attempt("bob", "no_answer"),
			attempt("carol", "sent", "call"),
		]);
		expect(actionsFor(ringing, "bob")).toEqual([]);
		expect(actionsFor(ringing, "carol")).toEqual([
			"seen",
			"answer",
			"accept",
			"decline",
		]);
		expect(
			actionsFor(need("open", [attempt("carol", "answered", "call")]), "carol"),
		).toEqual(["accept", "decline"]);
		expect(
			actionsFor(need("open", [attempt("carol", "queued")]), "carol"),
		).toEqual([]);
	});

	test("only the member who accepted confirms help; closed needs take no answers", () => {
		const accepted = need("accepted", [attempt("bob", "accepted")], "bob");
		expect(actionsFor(accepted, "bob")).toEqual(["help_confirmed"]);
		expect(actionsFor(accepted, "carol")).toEqual([]);
		expect(
			actionsFor(need("resolved", [attempt("bob", "accepted")], "bob"), "bob"),
		).toEqual([]);
		expect(
			actionsFor(need("unresolved", [attempt("bob", "no_answer")]), "bob"),
		).toEqual([]);
		expect(actionsFor(accepted, null)).toEqual([]);
	});
});
