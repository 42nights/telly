import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Marker,
	MarkerContent,
	MarkerIcon,
} from "@health/ui/components/marker";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Marker", () => {
	test("exposes slot and default variant as data attributes", () => {
		const view = render(<Marker data-testid="m">Today</Marker>);
		const el = view.getByTestId("m");
		expect(el.tagName).toBe("DIV");
		expect(el.getAttribute("data-slot")).toBe("marker");
		expect(el.getAttribute("data-variant")).toBe("default");
	});

	test("separator variant changes data-variant and styling", () => {
		const view = render(
			<Marker data-testid="m" variant="separator" className="mt-4" />,
		);
		const el = view.getByTestId("m");
		expect(el.getAttribute("data-variant")).toBe("separator");
		expect(el.className).toContain("before:h-px");
		expect(el.className).toContain("mt-4");
	});

	test("render prop swaps the element", () => {
		const view = render(<Marker render={<a href="/x" />}>Link</Marker>);
		const link = view.getByRole("link", { name: "Link" });
		expect(link.getAttribute("data-slot")).toBe("marker");
	});

	test("icon is hidden from assistive tech and content is a slot", () => {
		const view = render(
			<Marker>
				<MarkerIcon data-testid="i" className="text-red-500" />
				<MarkerContent>Body</MarkerContent>
			</Marker>,
		);
		const icon = view.getByTestId("i");
		expect(icon.getAttribute("aria-hidden")).toBe("true");
		expect(icon.className).toContain("text-red-500");
		expect(view.getByText("Body").getAttribute("data-slot")).toBe(
			"marker-content",
		);
	});
});
