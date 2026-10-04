import "@health/ui/test/register";

import { describe, expect, mock, test } from "bun:test";
import { Button, buttonVariants } from "@health/ui/components/button";
import { installDom } from "@health/ui/test/dom";
import { fireEvent, render } from "@testing-library/react";

installDom();

describe("Button", () => {
	test("renders a button with the default variant and size", () => {
		const view = render(<Button>Save</Button>);
		const button = view.getByRole("button", { name: "Save" });
		expect(button.dataset.slot).toBe("button");
		expect(button.classList.contains("bg-primary")).toBe(true);
		expect(button.classList.contains("h-8")).toBe(true);
	});

	test("variant and size props select different styles", () => {
		const view = render(
			<Button variant="destructive" size="icon-sm">
				X
			</Button>,
		);
		const button = view.getByRole("button", { name: "X" });
		expect(button.classList.contains("text-destructive")).toBe(true);
		expect(button.classList.contains("size-7")).toBe(true);
		expect(button.classList.contains("bg-primary")).toBe(false);
	});

	test("caller className overrides conflicting variant classes", () => {
		const view = render(<Button className="h-12">Tall</Button>);
		const button = view.getByRole("button", { name: "Tall" });
		expect(button.classList.contains("h-12")).toBe(true);
		expect(button.classList.contains("h-8")).toBe(false);
	});

	test("calls onClick when clicked", () => {
		const onClick = mock();
		const view = render(<Button onClick={onClick}>Go</Button>);
		fireEvent.click(view.getByRole("button", { name: "Go" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("disabled button does not fire onClick", () => {
		const onClick = mock();
		const view = render(
			<Button disabled onClick={onClick}>
				Go
			</Button>,
		);
		const button = view.getByRole("button", { name: "Go" });
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});

	test("render prop swaps the element while keeping button styles", () => {
		const view = render(
			<Button nativeButton={false} render={<a href="/home" />} variant="link">
				Home
			</Button>,
		);
		const link = view.getByText("Home").closest("a");
		expect(link?.getAttribute("href")).toBe("/home");
		expect(link?.dataset.slot).toBe("button");
		expect(link?.classList.contains("underline-offset-4")).toBe(true);
	});

	test("buttonVariants is usable for styling other elements", () => {
		expect(buttonVariants({ variant: "outline" })).toContain("border-border");
	});
});
