// Finder links and item questions over iMessage (#308; docs/board.html#hud-marker). The delivery
// operator reads and saves a person's last-seen places only through a finder link: the module shows
// it the places of a live link's person and saves a sighting only for that person. A link token or a
// page session leaves the server once and is stored only as its SHA-256.
import type { FinderImage, LinkedFinder } from "@health/contracts/finder-link";
import { ObjectCategory } from "@health/contracts/vision";
import { Effect, Schema } from "effect";
import { type Identity, Timestamp } from "spacetimedb";
import {
	callDb,
	type DbConfig,
	DbRejected,
	type FamilyDb,
	openFamilyDb,
} from "../db";
import { ApiFailure, newSecret, sha256Hex } from "../http";
import {
	createItemReader,
	type GeminiConfig,
	type PhotoItem,
} from "../integrations/gemini";

type LinkRow = {
	readonly tokenHash: string;
	readonly sessionHash: string | undefined;
	readonly familyId: bigint;
	readonly personId: Identity;
	readonly expiresAt: Timestamp;
	readonly sightings: readonly {
		readonly id: bigint;
		readonly container: string;
		readonly category: string;
		readonly place: string;
		readonly seenAt: Timestamp;
		readonly labelRead: boolean;
		readonly notFoundAt: Timestamp | undefined;
	}[];
};

/** Runs `use` with the delivery operator's connection, closed afterwards. */
export const withOperator = <A>(
	operator: DbConfig | undefined,
	use: (db: FamilyDb) => Promise<A>,
): Promise<A> => {
	if (operator === undefined)
		throw new ApiFailure(
			"unavailable",
			"Finder links are not set up on this server",
		);
	return Effect.runPromise(
		Effect.scoped(
			Effect.flatMap(openFamilyDb(operator), (db) =>
				Effect.promise(() => use(db)),
			),
		),
	);
};

/** The live link that `match` picks, or undefined when there is none or it has expired. */
const liveLink = (
	db: FamilyDb,
	match: (row: LinkRow) => boolean,
): LinkRow | undefined =>
	[...db.connection.db.finderLinks.iter()].find(
		(row) => match(row) && row.expiresAt.toDate().getTime() > Date.now(),
	);

const newestFirst = (row: Pick<LinkRow, "sightings">) =>
	[...row.sightings].sort(
		(a, b) => b.seenAt.toDate().getTime() - a.seenAt.toDate().getTime(),
	);

export const linkedFinder = (row: LinkRow, session: string): LinkedFinder => ({
	session,
	expiresAt: row.expiresAt.toDate().toISOString(),
	sightings: newestFirst(row).map((s) => ({
		id: s.id.toString(),
		container: s.container,
		category: Schema.is(ObjectCategory)(s.category) ? s.category : "other",
		place: s.place,
		seenAt: s.seenAt.toDate().toISOString(),
		notFoundAt: s.notFoundAt?.toDate().toISOString() ?? null,
	})),
});

const expired = () =>
	new ApiFailure(
		"unauthorized",
		"This link was used or has expired. Sign in to open the finder.",
	);

/** A new 15-minute link to the family wearer's places: its token and the places it shows. */
const createLink = async (db: FamilyDb, familyId: bigint) => {
	const { secret, hash } = newSecret();
	await Effect.runPromise(
		callDb(db, (c) =>
			c.reducers.createFinderLink({ familyId, tokenHash: hash }),
		),
	);
	const row = liveLink(db, (r) => r.tokenHash === hash);
	if (row === undefined)
		throw new ApiFailure("unavailable", "The finder link was not stored");
	return { token: secret, row };
};

/** Opens a link once. A used, expired, or unknown link answers 401: the page then signs in. */
export const openLink = async (
	db: FamilyDb,
	token: string,
): Promise<LinkedFinder> => {
	const tokenHash = sha256Hex(token);
	const session = newSecret();
	const opened = await Effect.runPromise(
		Effect.result(
			callDb(db, (c) =>
				c.reducers.openFinderLink({ tokenHash, sessionHash: session.hash }),
			),
		),
	);
	if (opened._tag === "Failure") {
		if (opened.failure instanceof DbRejected) throw expired();
		throw opened.failure;
	}
	const row = liveLink(db, (r) => r.tokenHash === tokenHash);
	if (row === undefined) throw expired();
	return linkedFinder(row, session.secret);
};

/** The link that a page session opened, while it is live. */
export const sessionLink = (db: FamilyDb, session: string) => {
	const sessionHash = sha256Hex(session);
	const row = liveLink(db, (r) => r.sessionHash === sessionHash);
	if (row === undefined) throw expired();
	return row;
};

/** Gemini's reading of a photo: the main item and where it is. Undefined without Gemini. */
export const photoReader = (gemini: GeminiConfig | undefined) => {
	if (gemini === undefined) return undefined;
	const read = createItemReader(gemini);
	return (image: FinderImage) =>
		Effect.runPromise(
			read(image).pipe(
				Effect.map(({ value }) => value),
				Effect.mapError(
					() =>
						new ApiFailure(
							"upstream_error",
							"The photo check did not answer. Try again in a minute.",
						),
				),
			),
		);
};

/** Saves the item of a photo for the link's person and returns what was saved. */
export const savePhotoItem = async (
	db: FamilyDb,
	row: LinkRow,
	read: (image: FinderImage) => Promise<PhotoItem>,
	image: FinderImage,
) => {
	const { item, category, place, confidence } = await read(image);
	if (item === "")
		throw new ApiFailure(
			"invalid_request",
			"I could not see one clear item in the photo. Take it again, closer.",
		);
	if (place === "")
		throw new ApiFailure(
			"invalid_request",
			"I could not see where it is. Take the photo again, a little further back.",
		);
	await Effect.runPromise(
		callDb(db, (c) =>
			c.reducers.rememberByFinderLink({
				tokenHash: row.tokenHash,
				container: item,
				category,
				place,
				seenAt: Timestamp.now(),
				confidence,
				labelRead: false,
			}),
		),
	);
	return { container: item, place };
};

const MEDICINE =
	/\b(?:meds?|medicines?|medications?|pills?|tablets?|capsules?|vitamins?|prescriptions?|inhalers?)\b/i;
// People are not items: "where is my daughter" stays a family question.
const PERSON =
	/\b(?:daughter|son|wife|husband|partner|kids?|children|family|grand\w*|mom|mum|mother|dad|father|brother|sister|friends?|doctor|nurse|carer|caregiver)\b/i;
// Words that end the item: "my pills this morning" → "pills".
const STOP =
	/^(?:again|now|today|tonight|yesterday|please|this|that|at|in|on|for|the)$/;

/** The item a text asks for ("where are my keys?" → "keys"), or undefined for other texts. */
export const itemAsk = (text: string): string | undefined => {
	const named =
		/\b(?:where|find|lost|misplaced|seen)\b[^?!.]*?\bmy\s+([^?!.,]+)/i.exec(
			text,
		)?.[1];
	if (named === undefined) return undefined;
	const words: string[] = [];
	for (const word of named.toLowerCase().trim().split(/\s+/)) {
		if (STOP.test(word) || words.length === 3) break;
		words.push(word);
	}
	const item = words.join(" ");
	return item === "" || PERSON.test(item) ? undefined : item;
};

/** A short reply that says a texted reminder is done: "Done", "Taken", "I ate", "Drank it". */
export const isDoneReply = (text: string) =>
	/^\s*(?:i\s+)?(?:done|taken|took (?:it|them)|did it|finished|ate|eaten|have eaten|drank|had (?:it|a drink|some))\b[^?]{0,30}$/i.test(
		text,
	);

const stems = (text: string) =>
	(text.toLowerCase().match(/[a-z]+/g) ?? []).map((w) =>
		w.replace(/(?:es|s)$/, ""),
	);

const ago = (seen: Date, now: number) => {
	const minutes = Math.round((now - seen.getTime()) / 60_000);
	if (minutes < 2) return "just now";
	if (minutes < 60) return `${minutes} minutes ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
};

/**
 * The answer to an item question: the newest saved thing whose name or category shares a word with
 * the item, or for a medicine word, the newest medicine. `link(object)` is the finder link for one
 * saved thing, or for Add a thing when `object` is undefined.
 */
export const itemReply = (
	item: string,
	row: Pick<LinkRow, "sightings">,
	link: (object: bigint | undefined) => string,
	now: number,
) => {
	const wanted = new Set(stems(item));
	const sightings = newestFirst(row);
	const found =
		sightings.find((s) =>
			stems(`${s.container} ${s.category}`).some((w) => wanted.has(w)),
		) ??
		(MEDICINE.test(item)
			? sightings.find((s) => s.category === "medicine")
			: undefined);
	if (found === undefined)
		return `I do not have your ${item} saved yet. Send me a photo of it where it is, and I will save the place. Or add it here: ${link(undefined)}`;
	const outdated =
		found.notFoundAt === undefined
			? ""
			: " It was not there when you last looked.";
	return `Your ${item}: ${found.place}, seen ${ago(found.seenAt.toDate(), now)}.${outdated}\nFind it: ${link(found.id)}`;
};

/** Find things (#301) for the wearer, opened by `token`: one saved thing, or Add a thing. */
const finderUrl = (
	appUrl: string,
	link: { readonly token: string; readonly row: LinkRow },
	item: string,
	object: bigint | undefined,
) => {
	const url = new URL("/find", appUrl);
	url.searchParams.set("person", link.row.familyId.toString());
	url.searchParams.set("member", link.row.personId.toHexString());
	if (object === undefined) url.searchParams.set("mode", "add");
	else url.searchParams.set("object", object.toString());
	url.searchParams.set("token", link.token);
	url.searchParams.set("q", item);
	return url.toString();
};

/** What the iMessage agent does for the wearer's item questions, "done" replies, and photos. */
export type WearerActions = {
	readonly findItem: (familyId: bigint, item: string) => Promise<string>;
	/** `words`: the wearer's reply, recorded for the family. */
	readonly done: (familyId: bigint, words: string) => Promise<string>;
	readonly savePhoto: (familyId: bigint, image: FinderImage) => Promise<string>;
};

export const wearerActions = (
	operator: DbConfig,
	appUrl: string,
	readItem: ((image: FinderImage) => Promise<PhotoItem>) | undefined,
): WearerActions => ({
	findItem: (familyId, item) =>
		withOperator(operator, async (db) => {
			const link = await createLink(db, familyId);
			return itemReply(
				item,
				link.row,
				(object) => finderUrl(appUrl, link, item, object),
				Date.now(),
			);
		}),
	done: (familyId, words) =>
		withOperator(operator, async (db) => {
			const answered = await Effect.runPromise(
				Effect.result(
					callDb(db, (c) =>
						c.reducers.answerTextedReminder({
							familyId,
							wording: words.trim().slice(0, 200),
						}),
					),
				),
			);
			if (answered._tag === "Success")
				return "Thank you. I noted that it is done.";
			if (answered.failure instanceof DbRejected)
				return "I have no reminder for you to answer right now.";
			throw answered.failure;
		}),
	savePhoto: (familyId, image) =>
		withOperator(operator, async (db) => {
			if (readItem === undefined)
				throw new ApiFailure("unavailable", "Photo checks are not set up");
			const link = await createLink(db, familyId);
			try {
				const { container, place } = await savePhotoItem(
					db,
					link.row,
					readItem,
					image,
				);
				const saved = liveLink(
					db,
					(r) => r.tokenHash === link.row.tokenHash,
				)?.sightings.find((s) => s.container === container)?.id;
				return `Saved: your ${container}, ${place}. Ask me "where are my ${container}?" any time.\nSee it: ${finderUrl(appUrl, link, container, saved)}`;
			} catch (error) {
				// The photo showed no clear item or place: say what to do again.
				if (error instanceof ApiFailure && error.code === "invalid_request")
					return error.message;
				throw error;
			}
		}),
});
