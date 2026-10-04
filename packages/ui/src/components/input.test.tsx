import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import { Input } from "@health/ui/components/input";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

installDom();

describe("Input", () => {
	test("renders an input slot that reports changes", async () => {
		const values: string[] = [];
		const view = render(
			<Input
				aria-label="Email"
				onChange={(e) => values.push(e.target.value)}
			/>,
		);
		const el = view.getByRole("textbox", { name: "Email" });
		expect(el.getAttribute("data-slot")).toBe("input");
		await userEvent.setup({ document }).type(el, "a@b.c");
		expect(values.at(-1)).toBe("a@b.c");
	});

	test("forwards the type prop", () => {
		const view = render(<Input aria-label="Pw" type="password" />);
		expect(view.getByLabelText("Pw").getAttribute("type")).toBe("password");
	});

	test("caller className overrides conflicting defaults", () => {
		const view = render(<Input aria-label="Email" className="h-10" />);
		const cls = view.getByRole("textbox").className;
		expect(cls).toContain("h-10");
		expect(cls).not.toContain("h-8");
	});
});
