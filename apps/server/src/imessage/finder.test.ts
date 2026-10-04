import { expect, test } from "bun:test";
import { Timestamp } from "spacetimedb";
import { isDoneReply, itemAsk, itemReply } from "./finder";
import { wearerPhones } from "./texts";

const now = Date.parse("2026-01-05T12:00:00Z");
const sighting = (
	id: bigint,
	container: string,
	category: string,
	place: string,
	hoursAgo: number,
) => ({
	id,
	container,
	category,
	place,
	seenAt: Timestamp.fromDate(new Date(now - hoursAgo * 3_600_000)),
	labelRead: false,
	notFoundAt: undefined,
});
const row = {
	sightings: [
		sighting(1n, "Lisinopril bottle", "medicine", "kitchen counter", 30),
		sighting(2n, "house keys", "keys", "hall table", 2),
		sighting(3n, "old keys", "keys", "drawer", 50),
		sighting(4n, "reading specs", "glasses", "bedside", 1),
	],
};
const link = (object: bigint | undefined) =>
	object === undefined ? "ADD" : `OBJ${object}`;

test("an item question answers the newest matching thing, or offers to save it", () => {
	expect(itemReply("keys", row, link, now)).toBe(
		"Your keys: hall table, seen 2 hours ago.\nFind it: OBJ2",
	);
	// A medicine word finds the newest medicine; a category finds a differently named thing.
	expect(itemReply("pills", row, link, now)).toBe(
		"Your pills: kitchen counter, seen yesterday.\nFind it: OBJ1",
	);
	expect(itemReply("glasses", row, link, now)).toBe(
		"Your glasses: bedside, seen 1 hour ago.\nFind it: OBJ4",
	);
	expect(itemReply("wallet", row, link, now)).toBe(
		"I do not have your wallet saved yet. Send me a photo of it where it is, and I will save the place. Or add it here: ADD",
	);
});

test("item questions and done replies are told apart from other texts", () => {
	expect(itemAsk("Where did I put my blood pressure pills this morning?")).toBe(
		"blood pressure pills",
	);
	expect(itemAsk("I can't find my keys")).toBe("keys");
	expect(itemAsk("Where is my daughter?")).toBeUndefined();
	expect(itemAsk("How did I sleep?")).toBeUndefined();
	for (const reply of ["Done", "I ate lunch", "drank it", "taken"])
		expect(isDoneReply(reply)).toBe(true);
	for (const other of [
		"Done?",
		"Did I take my pills?",
		"I ate the keys, where are they?",
	])
		expect(isDoneReply(other)).toBe(false);
});

test("only a family with exactly one address has a wearer phone", () => {
	expect(
		wearerPhones(
			new Map([
				["+15550001111", 3n],
				["+15550002222", 4n],
				["ana@example.com", 4n],
			]),
		),
	).toEqual(new Map([[3n, "+15550001111"]]));
});
