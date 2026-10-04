import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import { Textarea } from "@health/ui/components/textarea";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

installDom();

describe("Textarea", () => {
	test("renders a textbox slot that reports changes", async () => {
		const values: string[] = [];
		const view = render(
			<Textarea
				aria-label="Notes"
				onChange={(e) => values.push(e.target.value)}
			/>,
		);
		const el = view.getByRole("textbox", { name: "Notes" });
		expect(el.getAttribute("data-slot")).toBe("textarea");
		await userEvent.setup({ document }).type(el, "hi");
		expect(values.at(-1)).toBe("hi");
	});

	test("caller className overrides conflicting defaults", () => {
		const view = render(<Textarea aria-label="Notes" className="min-h-32" />);
		const cls = view.getByRole("textbox").className;
		expect(cls).toContain("min-h-32");
		expect(cls).not.toContain("min-h-16");
	});

	test("disabled prop disables the textarea", () => {
		const view = render(<Textarea aria-label="Notes" disabled />);
		expect((view.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
			true,
		);
	});
});
