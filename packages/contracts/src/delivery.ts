import { Schema } from "effect";
import { IdentityHex, UtcTime } from "./families";

// Food-delivery proposals and simulated orders (#43). When the wearer cannot prepare a meal, a
// family member proposes an order that keeps to the wearer's confirmed needs. Only a simulated
// provider exists: no proposal or order here reaches a real restaurant, courier, or payment
// account. All amounts are whole US cents.

const Text = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isNonEmpty(),
	Schema.isMaxLength(500),
);
/** An empty list means a person confirmed "none". */
const Confirmed = Schema.Array(Text).check(Schema.isMaxLength(20));
const Cents = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: 100_000 }),
);
const MenuItemId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/));

/** What a family member confirms before the order is proposed. Every field is required. */
export const DeliveryRequirements = Schema.Struct({
	/** The approved delivery address. */
	address: Text,
	/** Who will be there to receive the order, such as "Wearer, at home". */
	recipient: Text,
	/** No item may contain one of these allergens. */
	allergies: Confirmed,
	/** Every item must be marked suitable for each of these, such as "vegetarian". */
	dietaryNeeds: Confirmed,
	/** Help the wearer needs at the door, such as "Bring the bag inside". */
	assistance: Confirmed,
	window: Schema.Struct({ start: UtcTime, end: UtcTime }),
	/** The most the whole order may cost, fees, tax, and tip included. */
	budgetCents: Cents,
});
export type DeliveryRequirements = typeof DeliveryRequirements.Type;

export const OrderLine = Schema.Struct({
	menuItemId: MenuItemId,
	quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
});
export type OrderLine = typeof OrderLine.Type;

/** `POST /api/families/:familyId/delivery/proposals`. The server prices the items. */
export const NewDeliveryProposal = Schema.Struct({
	requirements: DeliveryRequirements,
	items: Schema.NonEmptyArray(OrderLine).check(Schema.isMaxLength(20)),
	tipCents: Cents,
});
export type NewDeliveryProposal = typeof NewDeliveryProposal.Type;

/** One item as the provider lists it. */
export const MenuItem = Schema.Struct({
	id: MenuItemId,
	name: Schema.String,
	priceCents: Cents,
	allergens: Schema.Array(Schema.String),
	suitableFor: Schema.Array(Schema.String),
});
export type MenuItem = typeof MenuItem.Type;

/** Every order goes to this provider. `simulated: true` means no real order or charge exists. */
export const DeliveryProvider = Schema.Struct({
	name: Schema.String,
	simulated: Schema.Literal(true),
});
export type DeliveryProvider = typeof DeliveryProvider.Type;

/** `GET /api/families/:familyId/delivery/menu`. */
export const DeliveryMenu = Schema.Struct({
	provider: DeliveryProvider,
	items: Schema.Array(MenuItem),
});
export type DeliveryMenu = typeof DeliveryMenu.Type;

export const DeliveryCosts = Schema.Struct({
	subtotalCents: Cents,
	feesCents: Cents,
	taxCents: Cents,
	tipCents: Cents,
	totalCents: Schema.Int,
});
export type DeliveryCosts = typeof DeliveryCosts.Type;

/**
 * `proposed`: waits for approval. `approved`: a person confirmed this exact proposal and total.
 * `replaced`: a substitution made a new proposal, which needs its own approval. `placed`: the
 * provider confirmed the order. `uncertain`: no reply in time, so the order may exist. `failed`:
 * the provider refused it. `delivered`: the provider says it arrived. `eaten`: a person reported
 * that the wearer ate. Delivery never sets `eaten`.
 */
export const OrderStatus = Schema.Literals([
	"proposed",
	"approved",
	"replaced",
	"placed",
	"uncertain",
	"failed",
	"delivered",
	"eaten",
]);
export type OrderStatus = typeof OrderStatus.Type;

/** What is fixed when a proposal is made. A change is a new proposal. */
export const ProposalSnapshot = Schema.Struct({
	/** The proposal this one replaces after a substitution. */
	replaces: Schema.NullOr(Schema.String),
	requirements: DeliveryRequirements,
	items: Schema.Array(
		Schema.Struct({ ...MenuItem.fields, quantity: OrderLine.fields.quantity }),
	),
	costs: DeliveryCosts,
});
export type ProposalSnapshot = typeof ProposalSnapshot.Type;

export const DeliveryProposal = Schema.Struct({
	...ProposalSnapshot.fields,
	id: Schema.String,
	familyId: Schema.String,
	provider: DeliveryProvider,
	status: OrderStatus,
	/** The proposal id, sent as the provider's idempotency key; `null` before the first attempt. */
	orderId: Schema.NullOr(Schema.String),
	/** Every status change, oldest first. */
	history: Schema.Array(
		Schema.Struct({
			status: OrderStatus,
			by: IdentityHex,
			at: Schema.String,
			note: Schema.String,
		}),
	),
});
export type DeliveryProposal = typeof DeliveryProposal.Type;

/** `GET /api/families/:familyId/delivery/proposals`: newest first. */
export const DeliveryProposals = Schema.Struct({
	proposals: Schema.Array(DeliveryProposal),
});
export type DeliveryProposals = typeof DeliveryProposals.Type;

/**
 * `POST …/proposals/:id/approval`: the explicit purchase confirmation. `totalCents` must equal the
 * proposal's total, so an approval cannot cover a different price.
 */
export const DeliveryApproval = Schema.Struct({
	purchase: Schema.Literal(true),
	totalCents: Schema.Int,
});
export type DeliveryApproval = typeof DeliveryApproval.Type;

/** `POST …/proposals/:id/substitutions`: makes a new proposal with one item changed. */
export const DeliverySubstitution = Schema.Struct({
	replace: MenuItemId,
	with: MenuItemId,
});
export type DeliverySubstitution = typeof DeliverySubstitution.Type;
