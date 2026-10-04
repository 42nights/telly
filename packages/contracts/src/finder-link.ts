// Finder links over iMessage (#308). The iMessage agent texts the wearer a link to their last-seen
// places: `<app>/medicine?person=<familyId>&link=<token>`. The page opens it without sign-in through
// `POST /api/finder-link/open`. A link works once and for 15 minutes; a used or expired one answers
// 401, and the page then asks for the normal sign-in. The page session that `open` returns lasts
// until the link expires and only adds photos for the same person (`POST /api/finder-link/photo`).
import { Schema } from "effect";
import { UtcTime } from "./families";
import { MAX_VISION_IMAGE_BYTES } from "./vision";

/** 32 random bytes, base64url without padding: the link token and the page session. */
const Secret = Schema.String.check(Schema.isPattern(/^[\w-]{43}$/));

export const OpenFinderLink = Schema.Struct({ token: Secret });
export type OpenFinderLink = typeof OpenFinderLink.Type;

/** One remembered place. A sighting is a past observation, never the item's current place. */
export const FinderSighting = Schema.Struct({
	id: Schema.String,
	/** What the item is, such as "Lisinopril bottle" or "house keys". */
	container: Schema.String,
	place: Schema.String,
	seenAt: UtcTime,
	/** The person later looked there and the item was not there. */
	notFoundAt: Schema.NullOr(UtcTime),
});
export type FinderSighting = typeof FinderSighting.Type;

/** The reply of `open` and `photo`: the wearer's places, newest first. */
export const LinkedFinder = Schema.Struct({
	session: Secret,
	expiresAt: UtcTime,
	/** Remembering places is off for this person: nothing is stored, and a photo is refused. */
	remembering: Schema.Boolean,
	sightings: Schema.Array(FinderSighting),
});
export type LinkedFinder = typeof LinkedFinder.Type;

/** Gemini reads these image types. At most `MAX_VISION_IMAGE_BYTES` once decoded. */
export const FinderImage = Schema.Struct({
	type: Schema.Literals([
		"image/jpeg",
		"image/png",
		"image/webp",
		"image/heic",
		"image/heif",
	]),
	data: Schema.String.check(
		Schema.isMaxLength(Math.ceil(MAX_VISION_IMAGE_BYTES / 3) * 4),
	),
});
export type FinderImage = typeof FinderImage.Type;

/** A photo of one item where it is now. The server names the item and the place, then saves them. */
export const FinderPhoto = Schema.Struct({
	session: Secret,
	image: FinderImage,
});
export type FinderPhoto = typeof FinderPhoto.Type;

export const FinderPhotoSaved = Schema.Struct({
	saved: Schema.Struct({ container: Schema.String, place: Schema.String }),
	finder: LinkedFinder,
});
export type FinderPhotoSaved = typeof FinderPhotoSaved.Type;
