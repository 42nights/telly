import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import { Label } from "@health/ui/components/label";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Label", () => {
	test("labels its associated control", () => {
		const view = render(
			<>
				<Label htmlFor="n" className="font-bold">
					Name
				</Label>
				<input id="n" />
			</>,
		);
		const input = view.getByLabelText("Name");
		expect(input.id).toBe("n");
		const label = view.getByText("Name");
		expect(label.getAttribute("data-slot")).toBe("label");
		expect(label.className).toContain("font-bold");
	});
});
