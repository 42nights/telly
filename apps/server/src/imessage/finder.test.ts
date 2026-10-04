import { expect, test } from "bun:test";
import { Timestamp } from "spacetimedb";
import { itemReply } from "./finder";
import { wearerPhones } from "./texts";

const now = Date.parse("2026-01-05T12:00:00Z");
const sighting = (
	id: bigint,
	container: string,
	place: string,
	hoursAgo: number,
	labelRead = false,
) => ({
	id,
	container,
	place,
	seenAt: Timestamp.fromDate(new Date(now - hoursAgo * 3_600_000)),
	labelRead,
	notFoundAt: undefined,
});
const row = {
	remembering: true,
	sightings: [
		sighting(1n, "Lisinopril bottle", "kitchen counter", 30, true),
		sighting(2n, "house keys", "hall table", 2),
		sighting(3n, "old keys", "drawer", 50),
	],
};
const link = (add: boolean) => (add ? "LINK&add=1" : "LINK");

test("an item question answers the newest matching place, or offers to save it", () => {
	expect(itemReply("keys", row, link, now)).toBe(
		"Your keys: hall table, seen 2 hours ago.\nFind it: LINK",
	);
	// A medicine word finds the newest medicine whose label was read.
	expect(itemReply("pills", row, link, now)).toBe(
		"Your pills: kitchen counter, seen yesterday.\nFind it: LINK",
	);
	expect(itemReply("wallet", row, link, now)).toBe(
		"I do not have your wallet saved yet. Send me a photo of it where it is, and I will save the place. Or add it here: LINK&add=1",
	);
	expect(itemReply("keys", { ...row, remembering: false }, link, now)).toMatch(
		/^Remembering where your things are is off/,
	);
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
