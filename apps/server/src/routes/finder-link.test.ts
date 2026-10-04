// Runs against a real local SpacetimeDB with the module published (`bun run db:test`), with the
// delivery operator's token. All records are synthetic.
import { describe, expect, test } from "bun:test";
import { ApiError } from "@health/contracts";
import { LinkedFinder } from "@health/contracts/finder-link";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { ApiFailure, errorStatus } from "../http";
import { wearerActions } from "../imessage/finder";
import { finderLinkRoutes } from "./finder-link";
import { dbConfig, openFamily, withDb } from "./test-family";

const operatorToken = process.env.SPACETIMEDB_OPERATOR_TOKEN;

/** The founder's own medicine memory, with one remembered place. */
const familyWithPlace = (name: string, container: string, place: string) =>
	Effect.gen(function* () {
		if (dbConfig === undefined) throw new Error("no database");
		const { db, familyId } = yield* openFamily(dbConfig, name);
		const personId = Identity.fromString(db.identity);
		yield* Effect.promise(() =>
			db.connection.reducers.setMedicineMemory({
				familyId: BigInt(familyId),
				personId,
				enabled: true,
				places: [place],
			}),
		);
		yield* Effect.promise(() =>
			db.connection.reducers.rememberMedicine({
				familyId: BigInt(familyId),
				personId,
				container,
				place,
				seenAt: Timestamp.now(),
				source: "camera_check",
				confidence: 0.9,
				labelRead: true,
			}),
		);
		return BigInt(familyId);
	});

describe.skipIf(dbConfig === undefined || operatorToken === undefined)(
	"finder links",
	() => {
		test("a texted link opens its wearer's places once, without sign-in", () =>
			withDb((config) =>
				Effect.gen(function* () {
					const operator = { ...config, token: operatorToken as string };
					const familyId = yield* familyWithPlace(
						"Finder family",
						"Synthetic Lisinopril bottle",
						"kitchen counter",
					);
					yield* familyWithPlace("Other family", "Synthetic keys", "hall");
					const wearer = wearerActions(operator, "https://app.test", undefined);

					const reply = yield* Effect.promise(() =>
						wearer.findItem(familyId, "pills"),
					);
					expect(reply).toStartWith(
						"Your pills: kitchen counter, seen just now.\nFind it: https://app.test/medicine?",
					);
					const link = new URL(reply.slice(reply.indexOf("https://")));
					expect(link.searchParams.get("person")).toBe(familyId.toString());
					const token = link.searchParams.get("link");

					const app = new Hono()
						.route("/", finderLinkRoutes(operator, undefined))
						.onError((error, c) => {
							if (!(error instanceof ApiFailure)) throw error;
							return c.json(
								{ error: error.code, message: error.message },
								errorStatus[error.code],
							);
						});
					const post = (path: string, body: unknown) =>
						Effect.promise(async () => {
							const response = await app.request(path, {
								method: "POST",
								body: JSON.stringify(body),
								headers: { "content-type": "application/json" },
							});
							return { status: response.status, json: await response.json() };
						});

					const opened = yield* post("/open", { token });
					expect(opened.status).toBe(200);
					const finder = Schema.decodeUnknownSync(LinkedFinder)(opened.json);
					// Only this family's wearer: the other family's keys never show.
					expect(finder.sightings.map((s) => s.container)).toEqual([
						"Synthetic Lisinopril bottle",
					]);

					const again = yield* post("/open", { token });
					expect(again.status).toBe(401);
					expect(Schema.decodeUnknownSync(ApiError)(again.json).error).toBe(
						"unauthorized",
					);
					const forged = yield* post("/photo", {
						session: "x".repeat(43),
						image: { type: "image/jpeg", data: "" },
					});
					expect(forged.status).toBe(401);

					expect(yield* Effect.promise(() => wearer.done(familyId))).toBe(
						"I have no reminder for you to answer right now.",
					);
				}),
			));
	},
);
