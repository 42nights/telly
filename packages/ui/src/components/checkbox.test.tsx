import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import { Checkbox } from "@health/ui/components/checkbox";
import { installDom } from "@health/ui/test/dom";
import { fireEvent, render } from "@testing-library/react";

installDom();

describe("Checkbox", () => {
	test("toggles checked state on click and reports it", () => {
		const calls: boolean[] = [];
		const view = render(
			<Checkbox aria-label="Agree" onCheckedChange={(c) => calls.push(c)} />,
		);
		const box = view.getByRole("checkbox", { name: "Agree" });
		expect(box.getAttribute("data-slot")).toBe("checkbox");
		expect(box.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(box);
		expect(calls).toEqual([true]);
		expect(box.getAttribute("aria-checked")).toBe("true");
		expect(box.hasAttribute("data-checked")).toBe(true);
	});

	test("shows the indicator only when checked", () => {
		const view = render(<Checkbox aria-label="Agree" defaultChecked />);
		const box = view.getByRole("checkbox");
		expect(
			box.querySelector('[data-slot="checkbox-indicator"]'),
		).not.toBeNull();
	});

	test("disabled checkbox ignores clicks", () => {
		const calls: boolean[] = [];
		const view = render(
			<Checkbox
				aria-label="Agree"
				disabled
				onCheckedChange={(c) => calls.push(c)}
			/>,
		);
		fireEvent.click(view.getByRole("checkbox"));
		expect(calls).toEqual([]);
	});

	test("merges caller className", () => {
		const view = render(<Checkbox aria-label="Agree" className="size-6" />);
		const cls = view.getByRole("checkbox").className;
		expect(cls).toContain("size-6");
		expect(cls).not.toContain("size-4");
	});
});
