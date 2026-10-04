// The food-delivery provider seam (#43) and its only implementation: a simulator. It keeps orders
// in memory, calls no network service, and charges nothing. docs/delivery.md lists why no real
// provider is connected.
import type {
	DeliveryCosts,
	MenuItem,
	OrderLine,
	DeliveryProvider as ProviderInfo,
} from "@health/contracts/delivery";

export type Quote =
	| {
			readonly items: readonly (MenuItem & { readonly quantity: number })[];
			readonly costs: Omit<DeliveryCosts, "tipCents" | "totalCents">;
	  }
	| { readonly unknownItem: string };

/** The provider's answer to a placement. Anything else (an error, no reply) is uncertain. */
export type Placement =
	| { readonly status: "placed" }
	| { readonly status: "refused"; readonly reason: string };

export type DeliveryProvider = {
	readonly info: ProviderInfo;
	readonly menu: () => Promise<readonly MenuItem[]>;
	readonly quote: (lines: readonly OrderLine[]) => Promise<Quote>;
	/**
	 * Places the order once per `orderId`: a repeat with the same id returns the first result and
	 * buys nothing more. `totalCents` is the approved total; any other price is refused.
	 */
	readonly place: (order: {
		readonly orderId: string;
		readonly lines: readonly OrderLine[];
		readonly tipCents: number;
		readonly totalCents: number;
	}) => Promise<Placement>;
	readonly track: (
		orderId: string,
	) => Promise<"placed" | "delivered" | "unknown">;
};

// Synthetic menu and prices. No real restaurant, item, or price.
const MENU: readonly MenuItem[] = [
	{
		id: "lentil-stew",
		name: "Lentil stew",
		priceCents: 1100,
		allergens: [],
		suitableFor: ["vegetarian", "vegan", "gluten-free", "soft"],
	},
	{
		id: "vegetable-soup",
		name: "Vegetable soup",
		priceCents: 850,
		allergens: ["celery"],
		suitableFor: ["vegetarian", "vegan", "soft"],
	},
	{
		id: "chicken-rice",
		name: "Chicken and rice",
		priceCents: 1250,
		allergens: [],
		suitableFor: ["gluten-free"],
	},
	{
		id: "fish-pie",
		name: "Fish pie",
		priceCents: 1400,
		allergens: ["fish", "milk"],
		suitableFor: ["soft"],
	},
	{
		id: "fruit-cup",
		name: "Fruit cup",
		priceCents: 450,
		allergens: [],
		suitableFor: ["vegetarian", "vegan", "gluten-free", "soft"],
	},
	{
		id: "salmon-platter",
		name: "Salmon platter",
		priceCents: 2400,
		allergens: ["fish"],
		suitableFor: ["gluten-free"],
	},
];

const quoteLines = (lines: readonly OrderLine[]): Quote => {
	const items = [];
	for (const line of lines) {
		const item = MENU.find((entry) => entry.id === line.menuItemId);
		if (item === undefined) return { unknownItem: line.menuItemId };
		items.push({ ...item, quantity: line.quantity });
	}
	const subtotalCents = items.reduce(
		(sum, item) => sum + item.priceCents * item.quantity,
		0,
	);
	return {
		items,
		costs: {
			subtotalCents,
			// A flat delivery fee plus a 5% service fee, and 8.875% tax: simulated rates.
			feesCents: 299 + Math.round(subtotalCents * 0.05),
			taxCents: Math.round(subtotalCents * 0.08875),
		},
	};
};

/** The simulated provider. `orderCount` lets a test prove that a retry bought nothing more. */
export const simulatedDelivery = (): DeliveryProvider & {
	readonly orderCount: () => number;
} => {
	const orders = new Map<string, Placement>();
	return {
		info: { name: "Simulated delivery (demo only)", simulated: true },
		menu: async () => MENU,
		quote: async (lines) => quoteLines(lines),
		place: async ({ orderId, lines, tipCents, totalCents }) => {
			const earlier = orders.get(orderId);
			if (earlier !== undefined) return earlier;
			const quote = quoteLines(lines);
			if ("unknownItem" in quote)
				return {
					status: "refused",
					reason: `${quote.unknownItem} is not on the menu`,
				};
			const { subtotalCents, feesCents, taxCents } = quote.costs;
			if (subtotalCents + feesCents + taxCents + tipCents !== totalCents)
				return {
					status: "refused",
					reason: "The price is not the approved total",
				};
			const placed = { status: "placed" } as const;
			orders.set(orderId, placed);
			return placed;
		},
		// ponytail: a simulated order counts as delivered as soon as anyone asks.
		track: async (orderId) =>
			orders.get(orderId)?.status === "placed" ? "delivered" : "unknown",
		orderCount: () => orders.size,
	};
};
