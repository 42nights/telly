import "@health/ui/test/register";

import { describe, expect, mock, test } from "bun:test";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupText,
	InputGroupTextarea,
} from "@health/ui/components/input-group";
import { installDom } from "@health/ui/test/dom";
import { fireEvent, render } from "@testing-library/react";

installDom();

describe("InputGroup", () => {
	test("renders a group with caller className merged", () => {
		const view = render(<InputGroup aria-label="g" className="extra" />);
		const group = view.getByRole("group", { name: "g" });
		expect(group.dataset.slot).toBe("input-group");
		expect(group.classList.contains("extra")).toBe(true);
	});
});

describe("InputGroupAddon", () => {
	test("clicking the addon focuses the group's input", () => {
		const view = render(
			<InputGroup>
				<InputGroupInput aria-label="Search" />
				<InputGroupAddon>icon</InputGroupAddon>
			</InputGroup>,
		);
		fireEvent.click(view.getByText("icon"));
		expect(document.activeElement).toBe(view.getByLabelText("Search"));
	});

	test("clicking the addon focuses the group's textarea", () => {
		const view = render(
			<InputGroup>
				<InputGroupTextarea aria-label="Message" />
				<InputGroupAddon align="block-end">hint</InputGroupAddon>
			</InputGroup>,
		);
		fireEvent.click(view.getByText("hint"));
		expect(document.activeElement).toBe(view.getByLabelText("Message"));
	});

	test("clicking a button inside the addon does not move focus to the input", () => {
		const onClick = mock();
		const view = render(
			<InputGroup>
				<InputGroupInput aria-label="Search" />
				<InputGroupAddon align="inline-end">
					<InputGroupButton onClick={onClick}>Clear</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>,
		);
		fireEvent.click(view.getByRole("button", { name: "Clear" }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(document.activeElement).not.toBe(view.getByLabelText("Search"));
	});

	test("defaults to inline-start alignment", () => {
		const view = render(<InputGroupAddon>a</InputGroupAddon>);
		expect(view.getByText("a").dataset.align).toBe("inline-start");
	});

	test("exposes each align value for caller styling", () => {
		for (const align of ["inline-end", "block-start", "block-end"] as const) {
			const view = render(
				<InputGroupAddon align={align} className="extra">
					{align}
				</InputGroupAddon>,
			);
			const addon = view.getByText(align);
			expect(addon.dataset.slot).toBe("input-group-addon");
			expect(addon.dataset.align).toBe(align);
			expect(addon.classList.contains("extra")).toBe(true);
			view.unmount();
		}
	});
});

describe("InputGroupButton", () => {
	test("defaults to type=button so it does not submit a parent form", () => {
		const onSubmit = mock((e: { preventDefault: () => void }) =>
			e.preventDefault(),
		);
		const view = render(
			<form onSubmit={onSubmit}>
				<InputGroupButton>Copy</InputGroupButton>
			</form>,
		);
		const button = view.getByRole("button", { name: "Copy" });
		expect(button.getAttribute("type")).toBe("button");
		expect(button.dataset.size).toBe("xs");
		fireEvent.click(button);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	test("type=submit is honored", () => {
		const view = render(
			<InputGroupButton type="submit">Send</InputGroupButton>,
		);
		expect(
			view.getByRole("button", { name: "Send" }).getAttribute("type"),
		).toBe("submit");
	});

	test("size prop changes the exposed size and dimensions", () => {
		const view = render(<InputGroupButton size="icon-sm">I</InputGroupButton>);
		const button = view.getByRole("button", { name: "I" });
		expect(button.dataset.size).toBe("icon-sm");
		expect(button.classList.contains("size-7")).toBe(true);
	});
});

describe("InputGroup controls", () => {
	test("InputGroupText renders text with merged className", () => {
		const view = render(<InputGroupText className="extra">USD</InputGroupText>);
		expect(view.getByText("USD").classList.contains("extra")).toBe(true);
	});

	test("InputGroupInput is marked as the group control and accepts typing", () => {
		const view = render(<InputGroupInput aria-label="Amount" />);
		const input = view.getByLabelText("Amount") as HTMLInputElement;
		expect(input.dataset.slot).toBe("input-group-control");
		fireEvent.change(input, { target: { value: "5" } });
		expect(input.value).toBe("5");
	});

	test("InputGroupTextarea is marked as the group control", () => {
		const view = render(
			<InputGroupTextarea aria-label="Notes" className="x" />,
		);
		const area = view.getByLabelText("Notes");
		expect(area.tagName).toBe("TEXTAREA");
		expect(area.dataset.slot).toBe("input-group-control");
		expect(area.classList.contains("x")).toBe(true);
	});
});
