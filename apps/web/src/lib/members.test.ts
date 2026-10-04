import { expect, test } from "bun:test";

import { isAlertMessage, memberLabel, senderLabel } from "./members";

const me = "a".repeat(64);
const other = `b12345${"c".repeat(58)}`;

test("a member is You or a short label, never the full identity", () => {
	expect(memberLabel(me, me)).toBe("You");
	expect(memberLabel(other, me)).toBe("Member b12345");
	expect(memberLabel(me, null)).toBe(`Member ${"a".repeat(6)}`);
});

test("only the alert worker's client id marks an alert message", () => {
	expect(isAlertMessage({ clientId: "alert-42" })).toBe(true);
	expect(isAlertMessage({ clientId: "c-alert-42" })).toBe(false);
	expect(isAlertMessage({ clientId: "msg-1" })).toBe(false);
});

test("the sender of a family message", () => {
	expect(senderLabel({ sender: other, clientId: "alert-1" }, other)).toBe(
		"Telly alert",
	);
	expect(senderLabel({ sender: me, clientId: "m-1" }, me)).toBe("You");
	expect(senderLabel({ sender: other, clientId: "m-2" }, me)).toBe(
		"Member b12345",
	);
});
