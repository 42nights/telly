// Food-delivery proposals and simulated orders (#43), relative to `/api/families/:familyId`. A
// proposal keeps to the needs a family member confirmed, and nothing is ordered without an
// explicit approval of its exact total. The proposal id is the provider's idempotency key: a retry
// after an uncertain placement first asks the provider whether the order exists, so it never buys
// twice. The only provider is a simulator (integrations/delivery.ts). Approving and ordering spend
// money, so both need the caller's #26 `purchases` scope now: a revoke stops the next order.
import {
	DeliveryApproval,
	type DeliveryMenu,
	type DeliveryProposal,
	type DeliveryProposals,
	type DeliveryRequirements,
	DeliverySubstitution,
	NewDeliveryProposal,
	type OrderLine,
	type OrderStatus,
	ProposalSnapshot,
} from "@health/contracts/delivery";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import type { DeliveryProvider } from "../integrations/delivery";
import { requireScope } from "./care-profile";

type Ctx = Context<FamilyEnv>;

const Snapshot = Schema.fromJsonString(ProposalSnapshot);

const statusOf = {
	Proposed: "proposed",
	Approved: "approved",
	Replaced: "replaced",
	Placed: "placed",
	Uncertain: "uncertain",
	Failed: "failed",
	Delivered: "delivered",
	Eaten: "eaten",
} as const satisfies Record<string, OrderStatus>;
type Tag = keyof typeof statusOf;

const NOT_ATTEMPTED: readonly OrderStatus[] = [
	"proposed",
	"approved",
	"replaced",
];

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const readProposals = (c: Ctx, provider: DeliveryProvider) => {
	const rows = [...c.var.db.connection.db.myDeliveryEvents.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	// Groups keep the order of their first row, so reversing lists the newest proposal first.
	return [...Map.groupBy(rows, (row) => row.proposalId)]
		.map(([id, events]): DeliveryProposal => {
			const history = events.map((row) => ({
				status: statusOf[row.status.tag],
				by: row.actor.toHexString(),
				at: row.at.toISOString(),
				note: row.note,
			}));
			return {
				...Schema.decodeUnknownSync(Snapshot)(events[0]?.proposal),
				id,
				familyId: c.var.familyId.toString(),
				provider: provider.info,
				status: history[history.length - 1]?.status ?? "proposed",
				orderId: history.some((step) => !NOT_ATTEMPTED.includes(step.status))
					? id
					: null,
				history,
			};
		})
		.reverse();
};

const findProposal = (c: Ctx, provider: DeliveryProvider, id: string) => {
	const found = readProposals(c, provider).find((p) => p.id === id);
	if (found === undefined)
		throw new ApiFailure(
			"not_found",
			"No such delivery proposal in this family",
		);
	return found;
};

const record = (
	c: Ctx,
	proposalId: string,
	tag: Tag,
	note: string,
	proposal?: string,
) =>
	callReducer(c.var.db, (connection) =>
		connection.reducers.recordDeliveryEvent({
			familyId: c.var.familyId,
			proposalId,
			status: { tag },
			proposal,
			note,
		}),
	);

/** Waits at most `ms` for a provider call. A thrown error counts as no reply. */
const within = async <A>(
	ms: number,
	call: () => Promise<A>,
): Promise<A | "no_reply"> => {
	const timeout = Promise.withResolvers<"no_reply">();
	const timer = setTimeout(() => timeout.resolve("no_reply"), ms);
	try {
		return await Promise.race([call(), timeout.promise]);
	} catch {
		return "no_reply";
	} finally {
		clearTimeout(timer);
	}
};

type Deps = { readonly provider: DeliveryProvider; readonly timeoutMs: number };

/** A provider read: no reply is `unavailable`, never an empty answer. */
const ask = async <A>({ timeoutMs }: Deps, call: () => Promise<A>) => {
	const answer = await within(timeoutMs, call);
	if (answer === "no_reply")
		throw new ApiFailure("unavailable", "The delivery provider did not answer");
	return answer;
};

const lower = (values: readonly string[]) =>
	values.map((value) => value.toLowerCase());

/** Refuses an item with a confirmed allergen or without a confirmed dietary need. */
const checkNeeds = (
	requirements: DeliveryRequirements,
	items: ProposalSnapshot["items"],
) => {
	const allergies = lower(requirements.allergies);
	const needs = lower(requirements.dietaryNeeds);
	for (const item of items) {
		const allergen = lower(item.allergens).find((a) => allergies.includes(a));
		if (allergen !== undefined)
			throw new ApiFailure(
				"invalid_request",
				`${item.name} contains ${allergen}, a confirmed allergy`,
			);
		const unmet = needs.find((need) => !lower(item.suitableFor).includes(need));
		if (unmet !== undefined)
			throw new ApiFailure(
				"invalid_request",
				`${item.name} is not marked ${unmet}`,
			);
	}
};

/** Prices the lines, checks them against the confirmed needs and budget, and records the proposal. */
const propose = async (
	c: Ctx,
	deps: Deps,
	proposal: Omit<ProposalSnapshot, "items" | "costs"> & {
		readonly lines: readonly OrderLine[];
		readonly tipCents: number;
		readonly note: string;
	},
) => {
	const { requirements, lines, tipCents } = proposal;
	const { start, end } = requirements.window;
	if (Date.parse(end) <= Math.max(Date.parse(start), Date.now()))
		throw new ApiFailure(
			"invalid_request",
			"The delivery window must end after it starts and after now",
		);
	const quote = await ask(deps, () => deps.provider.quote(lines));
	if ("unknownItem" in quote)
		throw new ApiFailure(
			"invalid_request",
			`${quote.unknownItem} is not on the menu`,
		);
	checkNeeds(requirements, quote.items);
	const { subtotalCents, feesCents, taxCents } = quote.costs;
	const totalCents = subtotalCents + feesCents + taxCents + tipCents;
	if (totalCents > requirements.budgetCents)
		throw new ApiFailure(
			"invalid_request",
			`The total ${dollars(totalCents)} with fees, tax, and tip is over the ${dollars(requirements.budgetCents)} budget`,
		);
	const snapshot: ProposalSnapshot = {
		replaces: proposal.replaces,
		requirements,
		items: quote.items,
		costs: { ...quote.costs, tipCents, totalCents },
	};
	const id = crypto.randomUUID();
	// A substitution retires the old proposal first: if the next write fails, nothing is bought twice.
	if (proposal.replaces !== null)
		await record(c, proposal.replaces, "Replaced", `Replaced by ${id}`);
	await record(
		c,
		id,
		"Proposed",
		proposal.note,
		Schema.encodeSync(Snapshot)(snapshot),
	);
	return id;
};

const linesOf = (proposal: DeliveryProposal): OrderLine[] =>
	proposal.items.map(({ id, quantity }) => ({ menuItemId: id, quantity }));

const conflict = (proposal: DeliveryProposal, action: string) =>
	new ApiFailure(
		"conflict",
		`The proposal is ${proposal.status}, so it cannot ${action}`,
	);

/** Places the approved order once, or records why it is not placed. */
const place = async (c: Ctx, deps: Deps, proposal: DeliveryProposal) => {
	if (Date.parse(proposal.requirements.window.end) <= Date.now())
		throw new ApiFailure(
			"conflict",
			"The delivery window has ended; make a new proposal",
		);
	const placed = await within(deps.timeoutMs, () =>
		deps.provider.place({
			orderId: proposal.id,
			lines: linesOf(proposal),
			tipCents: proposal.costs.tipCents,
			totalCents: proposal.costs.totalCents,
		}),
	);
	if (placed === "no_reply")
		return record(
			c,
			proposal.id,
			"Uncertain",
			`No reply within ${deps.timeoutMs / 1000} s; the order may exist. A retry checks with the provider first.`,
		);
	return placed.status === "placed"
		? record(
				c,
				proposal.id,
				"Placed",
				`Simulated order placed for ${dollars(proposal.costs.totalCents)}`,
			)
		: record(c, proposal.id, "Failed", placed.reason);
};

/** Orders an approved or failed proposal. After `uncertain`, asks about the order id first. */
const order = async (c: Ctx, deps: Deps, proposal: DeliveryProposal) => {
	if (proposal.status === "approved" || proposal.status === "failed")
		return place(c, deps, proposal);
	if (proposal.status !== "uncertain") throw conflict(proposal, "be ordered");
	const found = await ask(deps, () => deps.provider.track(proposal.id));
	if (found === "unknown") return place(c, deps, proposal);
	return record(
		c,
		proposal.id,
		"Placed",
		"Found by order check; not placed again",
	);
};

export const deliveryRoutes = (
	provider: DeliveryProvider,
	{ timeoutMs = 10_000 }: { timeoutMs?: number } = {},
) => {
	const deps = { provider, timeoutMs };
	const find = (c: Ctx) =>
		findProposal(c, provider, c.req.param("proposalId") ?? "");
	const reply = (c: Ctx, id: string, status: 200 | 201 = 200) =>
		c.json(findProposal(c, provider, id) satisfies DeliveryProposal, status);

	return new Hono<FamilyEnv>()
		.get("/delivery/menu", async (c) =>
			c.json({
				provider: provider.info,
				items: await ask(deps, provider.menu),
			} satisfies DeliveryMenu),
		)
		.get("/delivery/proposals", (c) =>
			c.json({
				proposals: readProposals(c, provider),
			} satisfies DeliveryProposals),
		)
		.get("/delivery/proposals/:proposalId", (c) => reply(c, find(c).id))
		.post("/delivery/proposals", async (c) => {
			const body = await decodeBody(c, NewDeliveryProposal);
			const id = await propose(c, deps, {
				replaces: null,
				requirements: body.requirements,
				lines: body.items,
				tipCents: body.tipCents,
				note: "Proposed",
			});
			return reply(c, id, 201);
		})
		.post("/delivery/proposals/:proposalId/substitutions", async (c) => {
			const change = await decodeBody(c, DeliverySubstitution);
			const old = find(c);
			if (!["proposed", "approved", "failed"].includes(old.status))
				throw conflict(old, "change");
			if (!old.items.some((item) => item.id === change.replace))
				throw new ApiFailure(
					"invalid_request",
					`${change.replace} is not in this proposal`,
				);
			const id = await propose(c, deps, {
				replaces: old.id,
				requirements: old.requirements,
				lines: linesOf(old).map((line) =>
					line.menuItemId === change.replace
						? { ...line, menuItemId: change.with }
						: line,
				),
				tipCents: old.costs.tipCents,
				note: `${change.replace} → ${change.with}; needs a new approval`,
			});
			return reply(c, id, 201);
		})
		.post("/delivery/proposals/:proposalId/approval", async (c) => {
			requireScope(c, "purchases");
			const { totalCents } = await decodeBody(c, DeliveryApproval);
			const proposal = find(c);
			if (proposal.status !== "proposed")
				throw conflict(proposal, "be approved");
			if (totalCents !== proposal.costs.totalCents)
				throw new ApiFailure(
					"conflict",
					`The approved total does not match the proposal total of ${dollars(proposal.costs.totalCents)}`,
				);
			await record(
				c,
				proposal.id,
				"Approved",
				`Purchase confirmed for ${dollars(totalCents)}`,
			);
			return reply(c, proposal.id);
		})
		.post("/delivery/proposals/:proposalId/order", async (c) => {
			requireScope(c, "purchases");
			const proposal = find(c);
			await order(c, deps, proposal);
			return reply(c, proposal.id);
		})
		.post("/delivery/proposals/:proposalId/refresh", async (c) => {
			const proposal = find(c);
			if (proposal.status !== "placed") throw conflict(proposal, "be tracked");
			const state = await ask(deps, () => provider.track(proposal.id));
			if (state === "unknown")
				throw new ApiFailure(
					"upstream_error",
					"The provider does not know this order",
				);
			if (state === "delivered")
				await record(
					c,
					proposal.id,
					"Delivered",
					"The provider reports delivery. This does not mean the wearer ate.",
				);
			return reply(c, proposal.id);
		})
		.post("/delivery/proposals/:proposalId/eaten", async (c) => {
			const proposal = find(c);
			if (proposal.status !== "delivered")
				throw conflict(proposal, "be reported eaten");
			await record(
				c,
				proposal.id,
				"Eaten",
				"A person reported that the wearer ate",
			);
			return reply(c, proposal.id);
		});
};
