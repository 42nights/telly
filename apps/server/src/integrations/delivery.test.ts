import { describe, expect, test } from "bun:test";
import { simulatedDelivery } from "./delivery";

// Two lentil stews (2 × 1100) and one fruit cup (450): subtotal 2650, fees 299 + 133, tax 235.
const lines = [
	{ menuItemId: "lentil-stew", quantity: 2 },
	{ menuItemId: "fruit-cup", quantity: 1 },
];
const total = 2650 + 432 + 235;

describe("simulatedDelivery", () => {
	test("every menu item has a unique id and a positive whole-cent price, and quotes at that price", async () => {
		const provider = simulatedDelivery();
		const menu = await provider.menu();
		expect(new Set(menu.map((item) => item.id)).size).toBe(menu.length);
		for (const item of menu) {
			expect(Number.isInteger(item.priceCents) && item.priceCents > 0).toBe(
				true,
			);
			expect(
				await provider.quote([{ menuItemId: item.id, quantity: 1 }]),
			).toMatchObject({ costs: { subtotalCents: item.priceCents } });
		}
	});

	test("quotes the subtotal, fees, and tax of the lines", async () => {
		const quote = await simulatedDelivery().quote(lines);
		expect(quote).toMatchObject({
			costs: { subtotalCents: 2650, feesCents: 432, taxCents: 235 },
		});
		expect(
			"items" in quote && quote.items.map((item) => [item.id, item.quantity]),
		).toEqual([
			["lentil-stew", 2],
			["fruit-cup", 1],
		]);
	});

	test("a quote names the first unknown item", async () => {
		expect(
			await simulatedDelivery().quote([
				{ menuItemId: "fruit-cup", quantity: 1 },
				{ menuItemId: "caviar", quantity: 1 },
			]),
		).toEqual({ unknownItem: "caviar" });
	});

	test("places the approved total once per order id; a retry buys nothing more", async () => {
		const provider = simulatedDelivery();
		const order = {
			orderId: "o1",
			lines,
			tipCents: 300,
			totalCents: total + 300,
		};
		expect(await provider.place(order)).toEqual({ status: "placed" });
		expect(await provider.place(order)).toEqual({ status: "placed" });
		expect(provider.orderCount()).toBe(1);
		expect(await provider.track("o1")).toBe("delivered");
	});

	test("refuses an unknown item and records nothing", async () => {
		const provider = simulatedDelivery();
		expect(
			await provider.place({
				orderId: "o2",
				lines: [{ menuItemId: "caviar", quantity: 1 }],
				tipCents: 0,
				totalCents: 1000,
			}),
		).toEqual({ status: "refused", reason: "caviar is not on the menu" });
		expect(provider.orderCount()).toBe(0);
		expect(await provider.track("o2")).toBe("unknown");
	});

	test("refuses a total that is not the approved price, then places the right one", async () => {
		const provider = simulatedDelivery();
		for (const totalCents of [total - 1, total + 1])
			expect(
				await provider.place({ orderId: "o3", lines, tipCents: 0, totalCents }),
			).toEqual({
				status: "refused",
				reason: "The price is not the approved total",
			});
		expect(provider.orderCount()).toBe(0);
		expect(
			await provider.place({
				orderId: "o3",
				lines,
				tipCents: 0,
				totalCents: total,
			}),
		).toEqual({ status: "placed" });
	});

	test("an order id never placed tracks as unknown", async () => {
		expect(await simulatedDelivery().track("nope")).toBe("unknown");
	});
});
