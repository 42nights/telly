import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@health/ui/components/card";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Card", () => {
	test("defaults to the default size", () => {
		const view = render(<Card>body</Card>);
		const card = view.getByText("body");
		expect(card.dataset.slot).toBe("card");
		expect(card.dataset.size).toBe("default");
	});

	test("exposes the sm size for caller styling", () => {
		const view = render(<Card size="sm">body</Card>);
		expect(view.getByText("body").dataset.size).toBe("sm");
	});

	test("merges caller className and forwards props", () => {
		const view = render(
			<Card className="custom" aria-label="profile">
				body
			</Card>,
		);
		const card = view.getByLabelText("profile");
		expect(card.classList.contains("custom")).toBe(true);
	});

	test("subcomponents render their slots with merged classNames", () => {
		const parts = [
			[CardHeader, "card-header"],
			[CardTitle, "card-title"],
			[CardDescription, "card-description"],
			[CardAction, "card-action"],
			[CardContent, "card-content"],
			[CardFooter, "card-footer"],
		] as const;
		for (const [Part, slot] of parts) {
			const view = render(<Part className="extra">{slot}</Part>);
			const el = view.getByText(slot);
			expect(el.dataset.slot).toBe(slot);
			expect(el.classList.contains("extra")).toBe(true);
			view.unmount();
		}
	});
});
