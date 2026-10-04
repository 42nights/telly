// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The provider
// is the in-memory simulator, so no real order or charge can happen. All records are synthetic.
import { describe, expect, test } from "bun:test";
import { DeliveryProposal } from "@health/contracts/delivery";
import { Effect, Schema } from "effect";
import { Identity } from "spacetimedb";
import { type FamilyDb, openFamilyDb } from "../db";
import {
	type DeliveryProvider,
	simulatedDelivery,
} from "../integrations/delivery";
import { deliveryRoutes } from "./delivery";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const hour = 3_600_000;
const requirements = {
	address: "1 Synthetic Lane, Testville",
	recipient: "Wearer, at home",
	allergies: ["Milk"],
	dietaryNeeds: ["gluten-free"],
	assistance: ["Bring the bag inside"],
	window: {
		start: new Date(Date.now() + hour).toISOString(),
		end: new Date(Date.now() + 3 * hour).toISOString(),
	},
	budgetCents: 2000,
};
const order = (menuItemId: string, quantity = 1) => ({
	requirements,
	items: [{ menuItemId, quantity }],
	tipCents: 100,
});
const decode = (response: { json: unknown }) =>
	Schema.decodeUnknownSync(DeliveryProposal)(response.json);

/** Grants or revokes `purchases` (#26) for the caller; a family's founder may set up sharing. */
const purchases = (db: FamilyDb, familyId: string, granted: boolean) =>
	Effect.promise(() =>
		db.connection.reducers.setCareGrant({
			familyId: BigInt(familyId),
			member: Identity.fromString(db.identity),
			scope: "purchases",
			granted,
		}),
	);

describe.skipIf(dbConfig === undefined)("food delivery", () => {
	test("needs, budget, approval, and a substitution guard the purchase", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Delivery family");
				const fake = simulatedDelivery();
				let soldOut = true;
				const provider: DeliveryProvider = {
					...fake,
					place: async (o) =>
						soldOut
							? { status: "refused", reason: "Chicken and rice is sold out" }
							: fake.place(o),
				};
				const app = familyApp(db, familyId, deliveryRoutes(provider));
				const propose = (body: unknown) =>
					send(app, "POST", "/delivery/proposals", body);

				// Allergy, unmet diet, and budget (fees, tax, and tip included) each refuse the proposal.
				for (const [item, quantity] of [
					["fish-pie", 1],
					["vegetable-soup", 1],
					["chicken-rice", 2],
				] as const)
					expect(failure(yield* propose(order(item, quantity)))).toEqual([
						400,
						"invalid_request",
					]);
				const list = yield* send(app, "GET", "/delivery/proposals");
				expect(list.json).toEqual({ proposals: [] });

				const created = yield* propose(order("chicken-rice"));
				expect(created.status).toBe(201);
				const first = decode(created);
				expect(first).toMatchObject({
					status: "proposed",
					orderId: null,
					provider: { simulated: true },
					costs: {
						subtotalCents: 1250,
						feesCents: 362,
						taxCents: 111,
						tipCents: 100,
						totalCents: 1823,
					},
				});
				const path = `/delivery/proposals/${first.id}`;

				// Membership alone cannot approve a purchase: it needs the #26 `purchases` scope.
				const exact = { purchase: true, totalCents: 1823 };
				const noAccess = yield* send(app, "POST", `${path}/approval`, exact);
				expect(failure(noAccess)).toEqual([403, "forbidden"]);
				expect(JSON.stringify(noAccess.json)).toContain("purchases");
				yield* purchases(db, familyId, true);
				// Nothing is ordered without an approval of the exact total.
				expect(failure(yield* send(app, "POST", `${path}/order`))).toEqual([
					409,
					"conflict",
				]);
				const wrong = { purchase: true, totalCents: 1700 };
				expect(
					failure(yield* send(app, "POST", `${path}/approval`, wrong)),
				).toEqual([409, "conflict"]);
				const approve = (p: string, totalCents: number) =>
					send(app, "POST", `${p}/approval`, { purchase: true, totalCents });
				expect(decode(yield* approve(path, 1823)).status).toBe("approved");

				// The provider refuses (sold out): the order fails and nothing is bought.
				const refused = decode(yield* send(app, "POST", `${path}/order`));
				expect(refused).toMatchObject({ status: "failed", orderId: first.id });
				expect(fake.orderCount()).toBe(0);

				// An over-budget substitute is refused and the old proposal stays as it was.
				const pricey = { replace: "chicken-rice", with: "salmon-platter" };
				expect(
					failure(yield* send(app, "POST", `${path}/substitutions`, pricey)),
				).toEqual([400, "invalid_request"]);
				expect(decode(yield* send(app, "GET", path)).status).toBe("failed");

				const swap = { replace: "chicken-rice", with: "lentil-stew" };
				const replaced = yield* send(
					app,
					"POST",
					`${path}/substitutions`,
					swap,
				);
				expect(replaced.status).toBe(201);
				const second = decode(replaced);
				expect(second).toMatchObject({
					status: "proposed",
					replaces: first.id,
				});
				expect(second.costs.totalCents).toBe(1652);
				expect(decode(yield* send(app, "GET", path)).status).toBe("replaced");

				// The substitute needs its own approval; the replaced proposal can never be ordered.
				soldOut = false;
				const next = `/delivery/proposals/${second.id}`;
				expect(failure(yield* send(app, "POST", `${next}/order`))).toEqual([
					409,
					"conflict",
				]);
				expect(failure(yield* send(app, "POST", `${path}/order`))).toEqual([
					409,
					"conflict",
				]);
				yield* approve(next, 1652);
				// A revoke after the approval stops the order; nothing is bought until it is granted again.
				yield* purchases(db, familyId, false);
				expect(failure(yield* send(app, "POST", `${next}/order`))).toEqual([
					403,
					"forbidden",
				]);
				expect(fake.orderCount()).toBe(0);
				yield* purchases(db, familyId, true);
				expect(decode(yield* send(app, "POST", `${next}/order`)).status).toBe(
					"placed",
				);
				expect(fake.orderCount()).toBe(1);

				// Delivery never confirms that the wearer ate; only a person's report does.
				expect(decode(yield* send(app, "POST", `${next}/refresh`)).status).toBe(
					"delivered",
				);
				const eaten = decode(yield* send(app, "POST", `${next}/eaten`));
				expect(eaten.history.map((step) => step.status)).toEqual([
					"proposed",
					"approved",
					"placed",
					"delivered",
					"eaten",
				]);

				// Another family's member sees nothing.
				const stranger = yield* openFamilyDb(config);
				const other = familyApp(stranger, familyId, deliveryRoutes(provider));
				expect(failure(yield* send(other, "GET", next))).toEqual([
					404,
					"not_found",
				]);
			}),
		));

	test("a retry after a timeout checks the order id before buying again", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Retry family");
				yield* purchases(db, familyId, true);
				const fake = simulatedDelivery();
				// The first attempt places the order but its reply is lost; the second reply is lost before placing.
				let attempts = 0;
				const provider: DeliveryProvider = {
					...fake,
					place: async (o) => {
						attempts += 1;
						if (attempts === 1) await fake.place(o);
						if (attempts <= 2) return Promise.withResolvers<never>().promise;
						return fake.place(o);
					},
				};
				const app = familyApp(
					db,
					familyId,
					deliveryRoutes(provider, { timeoutMs: 50 }),
				);
				const run = Effect.gen(function* () {
					const created = decode(
						yield* send(
							app,
							"POST",
							"/delivery/proposals",
							order("lentil-stew"),
						),
					);
					const path = `/delivery/proposals/${created.id}`;
					yield* send(app, "POST", `${path}/approval`, {
						purchase: true,
						totalCents: created.costs.totalCents,
					});
					return path;
				});

				const path = yield* run;
				expect(decode(yield* send(app, "POST", `${path}/order`)).status).toBe(
					"uncertain",
				);
				expect(fake.orderCount()).toBe(1);
				const reconciled = decode(yield* send(app, "POST", `${path}/order`));
				expect(reconciled.status).toBe("placed");
				expect(reconciled.history.at(-1)?.note).toContain("not placed again");
				expect([attempts, fake.orderCount()]).toEqual([1, 1]);
				expect(failure(yield* send(app, "POST", `${path}/order`))).toEqual([
					409,
					"conflict",
				]);

				// No order exists after the lost reply, so the retry places it once with the same id.
				const lost = yield* run;
				expect(decode(yield* send(app, "POST", `${lost}/order`)).status).toBe(
					"uncertain",
				);
				expect(fake.orderCount()).toBe(1);
				expect(decode(yield* send(app, "POST", `${lost}/order`)).status).toBe(
					"placed",
				);
				expect([attempts, fake.orderCount()]).toEqual([3, 2]);
			}),
		));
});
