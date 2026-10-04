// Finder links (#308), mounted at `/api/finder-link` before the sign-in check: the link itself is the
// credential. See `@health/contracts/finder-link`. Each request opens the delivery operator's
// connection, which reads and saves only the places of the link's person.
import {
	FinderPhoto,
	type FinderPhotoSaved,
	type LinkedFinder,
	OpenFinderLink,
} from "@health/contracts/finder-link";
import { MAX_VISION_IMAGE_BYTES } from "@health/contracts/vision";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DbConfig } from "../db";
import { ApiFailure, decodeBody } from "../http";
import {
	linkedFinder,
	openLink,
	photoReader,
	savePhotoItem,
	sessionLink,
	withOperator,
} from "../imessage/finder";
import type { GeminiConfig } from "../integrations/gemini";

const MAX_PHOTO_BODY_BYTES =
	Math.ceil(MAX_VISION_IMAGE_BYTES / 3) * 4 + 16 * 1024;

export const finderLinkRoutes = (
	operator: DbConfig | undefined,
	gemini: GeminiConfig | undefined,
) => {
	const readItem = photoReader(gemini);
	return new Hono()
		.post("/open", async (c) => {
			const { token } = await decodeBody(c, OpenFinderLink);
			const finder = await withOperator(operator, (db) => openLink(db, token));
			c.header("cache-control", "no-store");
			return c.json(finder satisfies LinkedFinder);
		})
		.post(
			"/photo",
			bodyLimit({
				maxSize: MAX_PHOTO_BODY_BYTES,
				onError: () => {
					throw new ApiFailure(
						"invalid_request",
						"The photo is too large (4 MiB at most)",
					);
				},
			}),
			async (c) => {
				const { session, image } = await decodeBody(c, FinderPhoto);
				const reply = await withOperator(operator, async (db) => {
					const link = sessionLink(db, session);
					if (readItem === undefined)
						throw new ApiFailure("unavailable", "Photo checks are not set up");
					const saved = await savePhotoItem(db, link, readItem, image);
					return {
						saved,
						finder: linkedFinder(sessionLink(db, session), session),
					};
				});
				c.header("cache-control", "no-store");
				return c.json(reply satisfies FinderPhotoSaved);
			},
		);
};
