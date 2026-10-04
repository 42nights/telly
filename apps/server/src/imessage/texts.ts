// The wearer text outbox (#308). It runs as the delivery operator, reads every family's pending
// wearer texts, and sends each to the family's wearer phone over iMessage. The database made each
// text once per event and set when it may go (after quiet hours). Logs name the text key only: never
// the phone number or the text.
import { Duration, Effect, Schedule } from "effect";
import { callDb, type DbConfig, type FamilyDb, openFamilyDb } from "../db";

// A text this late would confuse more than help: a reminder from an hour ago, for example.
const STALE_MS = 30 * 60_000;
const MAX_TRIES = 3;

/**
 * The wearer phone of each family: the one address of `TELLY_IMESSAGE_SENDERS` mapped to it. A
 * family with more addresses gets no wearer texts, because nothing says which one is the wearer's.
 */
export const wearerPhones = (senders: ReadonlyMap<string, bigint>) => {
	const byFamily = new Map<bigint, string[]>();
	for (const [address, familyId] of senders)
		byFamily.set(familyId, [...(byFamily.get(familyId) ?? []), address]);
	const phones = new Map<bigint, string>();
	for (const [familyId, [address, ...others]] of byFamily)
		if (address !== undefined && others.length === 0)
			phones.set(familyId, address);
	return phones;
};

/** Sends due texts forever. `db` must be the delivery operator's connection. */
const runWearerTexts = (
	db: FamilyDb,
	send: (address: string, body: string) => Promise<void>,
	phones: ReadonlyMap<bigint, string>,
	pollEvery: Duration.Input = Duration.seconds(5),
) => {
	// ponytail: send, then settle. A crash between the two, or a second container during a rollout,
	// can send a text twice; add a claim with a lease (as the alert outbox has) if that is seen.
	const failures = new Map<string, number>();
	const settle = (key: string, sent: boolean, note?: string) =>
		callDb(db, (c) => c.reducers.settleWearerText({ key, sent, note }));
	const step = (
		text: { key: string; familyId: bigint; body: string; notBefore: Date },
		now: number,
	) =>
		Effect.gen(function* () {
			const phone = phones.get(text.familyId);
			if (phone === undefined)
				return yield* settle(
					text.key,
					false,
					"No wearer phone is on file for this family",
				);
			if (now - text.notBefore.getTime() > STALE_MS)
				return yield* settle(text.key, false, "Too late to send");
			const sent = yield* Effect.result(
				Effect.tryPromise(() => send(phone, text.body)),
			);
			if (sent._tag === "Success") {
				failures.delete(text.key);
				return yield* settle(text.key, true);
			}
			const tries = (failures.get(text.key) ?? 0) + 1;
			failures.set(text.key, tries);
			yield* Effect.logWarning(
				`wearer text ${text.key}: send failed (${tries})`,
			);
			if (tries < MAX_TRIES) return;
			failures.delete(text.key);
			yield* settle(text.key, false, "iMessage did not accept the text");
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(`wearer text ${text.key}: step failed`, cause),
			),
		);
	return Effect.gen(function* () {
		// The cached queue goes stale when the connection drops; fail so the caller reopens it.
		if (!db.connection.isActive)
			return yield* Effect.fail(new Error("operator connection closed"));
		const now = Date.now();
		for (const row of [...db.connection.db.pendingWearerTexts.iter()]) {
			const notBefore = row.notBefore.toDate();
			if (notBefore.getTime() <= now) yield* step({ ...row, notBefore }, now);
		}
		yield* Effect.sleep(pollEvery);
	}).pipe(Effect.forever);
};

/**
 * Runs the outbox for the server's lifetime as the delivery operator, opening the connection again
 * whenever it fails. With an https `wakeUrl`, the database opens it when a text is due, so a
 * sleeping server container starts in time to send it.
 */
export const wearerTextWorker = (
	operator: DbConfig,
	send: (address: string, body: string) => Promise<void>,
	phones: ReadonlyMap<bigint, string>,
	wakeUrl: string | undefined,
) =>
	Effect.scoped(
		Effect.flatMap(openFamilyDb(operator), (db) =>
			Effect.andThen(
				wakeUrl === undefined
					? Effect.void
					: callDb(db, (c) => c.reducers.setServerWake({ url: wakeUrl })).pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning(
									"could not save the server wake address",
									cause,
								),
							),
						),
				runWearerTexts(db, send, phones),
			),
		),
	).pipe(
		Effect.tapCause((cause) =>
			Effect.logWarning("wearer texts stopped; reopening", cause),
		),
		Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
	);
