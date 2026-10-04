// Proves the AR object pin storage (contract telly-ar-pin, generalized to any object in #301)
// through the real server and the real SpacetimeDB: the creator remembers an object, pins it with a
// world map, reads the same bytes back, replaces and deletes it, cannot store a map over 16 MB, and
// turning their memory off deletes their pin rows and stored maps. The first `containers` path still
// names the same pin. A member without care access cannot touch another member's pin, and a
// signed-in non-member is refused. Only the OIDC issuer and the R2 bucket are fake. The world maps
// are random bytes.
import { beforeAll, describe, expect, test } from "bun:test";
import {
	MAX_WORLD_MAP_BYTES,
	MedicineArPin,
	StoredMedicineArPin,
} from "@health/contracts/medicine-ar-pin";
import { MedicineMemory } from "@health/contracts/medicine-memory";
import {
	addMember,
	createFamily,
	errorOf,
	integration,
	json,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;
const harness = () => {
	if (it === undefined) throw new Error("integration is off");
	return it;
};

// Distinct, deterministic bytes per `seed`.
const worldMap = (bytes: number, seed = 0) =>
	new Uint8Array(bytes).map((_, i) => (i * 31 + seed) % 256);

describe.skipIf(!integration)("object AR pins", () => {
	let owner: User;
	let relative: User;
	let outsider: User;
	let family: { id: string; path: string };
	const sightingIds: string[] = [];
	const pinPath = (index: number) =>
		`${family.path}/medicine-memory/objects/${sightingIds[index]}/ar-pin`;
	const stored = (index: number) =>
		harness().bucket.get(`ar-pins/${family.id}/${sightingIds[index]}.worldmap`);
	const first = worldMap(4096);

	beforeAll(async () => {
		const { signIn } = harness();
		const run = crypto.randomUUID();
		owner = await signIn(`ar-pin-owner-${run}`);
		relative = await signIn(`ar-pin-relative-${run}`);
		outsider = await signIn(`ar-pin-outsider-${run}`);
		family = await createFamily(owner, "AR pins");
		await addMember(owner, family.path, relative);
		await json(
			MedicineMemory,
			await owner.call("PUT", `${family.path}/medicine-memory`, {
				enabled: true,
				places: ["Kitchen"],
			}),
		);
		for (const container of ["Synthetic pill box", "Synthetic keys"]) {
			const memory = await json(
				MedicineMemory,
				await owner.call("POST", `${family.path}/medicine-memory/sightings`, {
					container,
					place: "Kitchen",
					seenAt: new Date().toISOString(),
					source: "camera_check",
					confidence: 0.9,
					labelRead: true,
				}),
			);
			const id = memory.sightings.find((s) => s.container === container)?.id;
			if (id === undefined) throw new Error("the sighting was not stored");
			sightingIds.push(id);
		}
	});

	test("a pin stores the map privately at its key, logs none of it, and reads back the same bytes", async () => {
		const base64 = first.toBase64();
		const logged: string[] = [];
		const { log, error, warn } = console;
		const keep = (...args: unknown[]) => void logged.push(args.join(" "));
		Object.assign(console, { log: keep, error: keep, warn: keep });
		let response: Response;
		try {
			response = await owner.call("PUT", pinPath(0), {
				anchorId: "anchor-1",
				worldMap: base64,
			});
		} finally {
			Object.assign(console, { log, error, warn });
		}
		const pin = await json(MedicineArPin, response);
		expect(pin).toMatchObject({
			familyId: family.id,
			objectId: sightingIds[0],
			anchorId: "anchor-1",
			mapBytes: first.length,
		});
		expect(logged.join("\n")).not.toContain(base64.slice(0, 64));
		expect(stored(0)?.body).toEqual(first);
		expect(stored(0)?.type).toBe("application/octet-stream");

		const read = await json(
			StoredMedicineArPin,
			await owner.call("GET", pinPath(0)),
		);
		expect(read).toEqual({ ...pin, worldMap: base64 });

		// The first path names the same pin, so the pins saved before #301 stay readable.
		const legacy = await json(
			StoredMedicineArPin,
			await owner.call(
				"GET",
				`${family.path}/medicine-memory/containers/${sightingIds[0]}/ar-pin`,
			),
		);
		expect(legacy).toEqual(read);

		// The object list says which things have a pin, so the iPhone can start AR find for them.
		const memory = await json(
			MedicineMemory,
			await owner.call("GET", `${family.path}/medicine-memory`),
		);
		expect(memory.sightings.map((s) => [s.id, s.pinned]).toSorted()).toEqual(
			[
				[sightingIds[0], true],
				[sightingIds[1], false],
			].toSorted(),
		);
	});

	test("a new pin replaces the anchor and map and keeps when it was first made", async () => {
		const before = await json(
			StoredMedicineArPin,
			await owner.call("GET", pinPath(0)),
		);
		const next = worldMap(2048);
		const pin = await json(
			MedicineArPin,
			await owner.call("PUT", pinPath(0), {
				anchorId: "anchor-2",
				worldMap: next.toBase64(),
			}),
		);
		expect(pin.anchorId).toBe("anchor-2");
		expect(pin.mapBytes).toBe(2048);
		expect(pin.createdAt).toBe(before.createdAt);
		expect(stored(0)?.body).toEqual(next);
	});

	test("a map of exactly 16 MB is kept; one byte more is refused and stores nothing", async () => {
		const max = worldMap(MAX_WORLD_MAP_BYTES);
		const kept = await json(
			MedicineArPin,
			await owner.call("PUT", pinPath(1), {
				anchorId: "anchor-max",
				worldMap: max.toBase64(),
			}),
		);
		expect(kept.mapBytes).toBe(MAX_WORLD_MAP_BYTES);

		const before = stored(0)?.body;
		const over = await owner.call("PUT", pinPath(0), {
			anchorId: "anchor-over",
			worldMap: worldMap(MAX_WORLD_MAP_BYTES + 1).toBase64(),
		});
		expect(await errorOf(over)).toEqual([400, "invalid_request"]);
		expect(stored(0)?.body).toBe(before);
		const read = await json(
			StoredMedicineArPin,
			await owner.call("GET", pinPath(0)),
		);
		expect(read.anchorId).toBe("anchor-2");
	});

	test("a signed-in non-member cannot read, replace, or delete a pin", async () => {
		const before = stored(0)?.body;
		for (const [method, body] of [
			["GET", undefined],
			["PUT", { anchorId: "theirs", worldMap: worldMap(16).toBase64() }],
			["DELETE", undefined],
		] as const)
			expect(
				await errorOf(await outsider.call(method, pinPath(0), body)),
			).toEqual([403, "forbidden"]);
		expect(stored(0)?.body).toBe(before);
	});

	test("a member without care access cannot read, replace, or delete another member's pin", async () => {
		const before = stored(0)?.body;
		for (const [method, body] of [
			["GET", undefined],
			["PUT", { anchorId: "theirs", worldMap: worldMap(16).toBase64() }],
			["DELETE", undefined],
		] as const)
			expect(
				await errorOf(await relative.call(method, pinPath(0), body)),
			).toEqual([404, "not_found"]);
		expect(stored(0)?.body).toBe(before);
	});

	test("a pin is refused for an object that is not a sighting of the family", async () => {
		const response = await owner.call(
			"PUT",
			`${family.path}/medicine-memory/objects/999999999/ar-pin`,
			{ anchorId: "anchor", worldMap: first.toBase64() },
		);
		expect(await errorOf(response)).toEqual([404, "not_found"]);
	});

	test("deleting a pin deletes its row and its map", async () => {
		const deleted = await owner.call("DELETE", pinPath(0));
		expect(deleted.status).toBe(204);
		expect(stored(0)).toBeUndefined();
		expect(await errorOf(await owner.call("GET", pinPath(0)))).toEqual([
			404,
			"not_found",
		]);
	});

	test("turning a member's memory off deletes their pin rows and maps, and no one else's", async () => {
		await json(
			MedicineArPin,
			await owner.call("PUT", pinPath(0), {
				anchorId: "anchor-3",
				worldMap: first.toBase64(),
			}),
		);
		// The relative pins their own object.
		await json(
			MedicineMemory,
			await relative.call("PUT", `${family.path}/medicine-memory`, {
				enabled: true,
				places: [],
			}),
		);
		const theirs = await json(
			MedicineMemory,
			await relative.call("POST", `${family.path}/medicine-memory/sightings`, {
				container: "Synthetic glasses",
				place: "Desk",
				seenAt: new Date().toISOString(),
				source: "camera_check",
				confidence: 0.9,
				labelRead: true,
				category: "glasses",
			}),
		);
		const theirId = theirs.sightings[0]?.id;
		const theirPin = `${family.path}/medicine-memory/objects/${theirId}/ar-pin`;
		await json(
			MedicineArPin,
			await relative.call("PUT", theirPin, {
				anchorId: "anchor-relative",
				worldMap: first.toBase64(),
			}),
		);
		const prefix = `ar-pins/${family.id}/`;
		const keys = () =>
			[...harness().bucket.keys()].filter((key) => key.startsWith(prefix));
		expect(keys()).toHaveLength(3);

		await json(
			MedicineMemory,
			await owner.call("PUT", `${family.path}/medicine-memory`, {
				enabled: false,
				places: [],
			}),
		);
		expect(keys()).toEqual([`${prefix}${theirId}.worldmap`]);
		// The objects are deleted with the memory, so their pins are gone too.
		for (const index of [0, 1])
			expect(await errorOf(await owner.call("GET", pinPath(index)))).toEqual([
				404,
				"not_found",
			]);
		const refused = await owner.call("PUT", pinPath(0), {
			anchorId: "anchor-4",
			worldMap: first.toBase64(),
		});
		expect(await errorOf(refused)).toEqual([404, "not_found"]);
		expect(
			(await json(StoredMedicineArPin, await relative.call("GET", theirPin)))
				.anchorId,
		).toBe("anchor-relative");
	});
});
