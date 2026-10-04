// Per-question, family-scoped access for the Fetch.ai worker. While a member's question runs, the
// server lends the worker that member's database connection for that one family: the worker's
// `POST /api/families/:familyId/tools` call carries the delegation, and the tool reads through the
// asking member's views. The worker needs no standing membership, so every family works, and the
// access ends when the question does. A delegation is an unguessable 256-bit value that only lives in
// this process; it is never stored. It travels through Agentverse, so on its own it grants nothing:
// the caller must also sign in.
import type { FamilyDb } from "./db";

type Delegation = {
	readonly db: FamilyDb;
	readonly familyId: bigint;
	readonly expiresAt: number;
};

const live = new Map<string, Delegation>();

// ponytail: in-process map; the API runs one container per deploy. Share it (or sign the
// delegation) if the API ever runs more than one instance.
/** Lends `db` for `familyId` until `release` or `ttlMs`, whichever comes first. */
export const delegate = (db: FamilyDb, familyId: bigint, ttlMs = 120_000) => {
	const now = Date.now();
	for (const [token, entry] of live)
		if (entry.expiresAt <= now) live.delete(token);
	const token = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("base64url");
	live.set(token, { db, familyId, expiresAt: now + ttlMs });
	return { token, release: () => live.delete(token) };
};

/** The lent connection, or `undefined` when the delegation is unknown, released, expired, or for another family. */
export const redeem = (
	token: string,
	familyId: bigint,
): FamilyDb | undefined => {
	const entry = live.get(token);
	if (entry === undefined || entry.familyId !== familyId) return undefined;
	if (entry.expiresAt > Date.now() && entry.db.connection.isActive)
		return entry.db;
	live.delete(token);
	return undefined;
};
