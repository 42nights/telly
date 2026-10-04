import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@health/ui/components/tooltip";
import { installDom } from "@health/ui/test/dom";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

installDom();
const body = within(document.body);

describe("Tooltip", () => {
	test("hovering the trigger shows the content and leaving hides it", async () => {
		const user = userEvent.setup({ document });
		const view = render(
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger>Info</TooltipTrigger>
					<TooltipContent>Helpful hint</TooltipContent>
				</Tooltip>
			</TooltipProvider>,
		);
		const trigger = view.getByRole("button", { name: "Info" });
		expect(body.queryByText("Helpful hint")).toBeNull();

		await user.hover(trigger);
		await body.findByText("Helpful hint");
		expect(trigger.hasAttribute("data-popup-open")).toBe(true);

		await user.unhover(trigger);
		await waitFor(() => expect(body.queryByText("Helpful hint")).toBeNull());
	});

	test("focusing the trigger shows the content", async () => {
		const view = render(
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger>Info</TooltipTrigger>
					<TooltipContent>Focus hint</TooltipContent>
				</Tooltip>
			</TooltipProvider>,
		);
		const user = userEvent.setup({ document });
		await user.tab();
		expect(document.activeElement).toBe(
			view.getByRole("button", { name: "Info" }),
		);
		await body.findByText("Focus hint");
	});

	test("content defaults to the top side", () => {
		render(
			<Tooltip open>
				<TooltipTrigger>Info</TooltipTrigger>
				<TooltipContent>Default side</TooltipContent>
			</Tooltip>,
		);
		const popup = body
			.getByText("Default side")
			.closest('[data-slot="tooltip-content"]');
		expect(popup?.getAttribute("data-side")).toBe("top");
	});

	test("side prop and caller className reach the popup", () => {
		render(
			<Tooltip open>
				<TooltipTrigger>Info</TooltipTrigger>
				<TooltipContent side="bottom" className="custom-tip">
					Bottom tip
				</TooltipContent>
			</Tooltip>,
		);
		const popup = body
			.getByText("Bottom tip")
			.closest('[data-slot="tooltip-content"]');
		expect(popup?.getAttribute("data-side")).toBe("bottom");
		expect(popup?.className).toContain("custom-tip");
	});
});
