import "@health/ui/test/register";

import { describe, expect, mock, test } from "bun:test";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@health/ui/components/dropdown-menu";
import { installDom } from "@health/ui/test/dom";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

installDom();
const body = within(document.body);

describe("DropdownMenu", () => {
	test("trigger click opens the menu and Escape closes it", async () => {
		const user = userEvent.setup({ document });
		const view = render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent className="custom-content">
					<DropdownMenuItem>Profile</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const trigger = view.getByRole("button", { name: "Open" });
		expect(body.queryByRole("menu")).toBeNull();

		await user.click(trigger);
		const menu = await body.findByRole("menu");
		expect(menu.getAttribute("data-slot")).toBe("dropdown-menu-content");
		expect(menu.className).toContain("custom-content");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");

		await user.keyboard("{Escape}");
		await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	test("ArrowDown on the trigger opens the menu and moves focus through items", async () => {
		const user = userEvent.setup({ document });
		const view = render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>First</DropdownMenuItem>
					<DropdownMenuItem>Second</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		view.getByRole("button", { name: "Open" }).focus();
		await user.keyboard("{ArrowDown}");
		await body.findByRole("menu");
		await waitFor(() =>
			expect(document.activeElement?.textContent).toBe("First"),
		);
		await user.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(document.activeElement?.textContent).toBe("Second"),
		);
	});

	test("selecting an item calls onClick and closes the menu", async () => {
		const user = userEvent.setup({ document });
		const onClick = mock();
		const view = render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onClick={onClick}>Profile</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		await user.click(view.getByRole("button", { name: "Open" }));
		await user.click(await body.findByRole("menuitem", { name: "Profile" }));
		expect(onClick).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
	});

	test("item variant and inset map to data attributes", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>Plain</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" inset>
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const plain = body.getByRole("menuitem", { name: "Plain" });
		const destructive = body.getByRole("menuitem", { name: "Delete" });
		expect(plain.getAttribute("data-variant")).toBe("default");
		expect(plain.hasAttribute("data-inset")).toBe(false);
		expect(destructive.getAttribute("data-variant")).toBe("destructive");
		expect(destructive.getAttribute("data-inset")).toBe("true");
	});

	test("disabled item does not fire onClick", async () => {
		const user = userEvent.setup({ document });
		const onClick = mock();
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem disabled onClick={onClick}>
						Locked
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const item = body.getByRole("menuitem", { name: "Locked" });
		expect(item.getAttribute("aria-disabled")).toBe("true");
		await user.click(item);
		expect(onClick).not.toHaveBeenCalled();
	});

	test("label, group, separator and shortcut render with their slots", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						<DropdownMenuLabel inset>Account</DropdownMenuLabel>
						<DropdownMenuItem>
							Save
							<DropdownMenuShortcut className="custom-shortcut">
								⌘S
							</DropdownMenuShortcut>
						</DropdownMenuItem>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const group = body.getByRole("group", { name: "Account" });
		expect(group.getAttribute("data-slot")).toBe("dropdown-menu-group");
		const label = body.getByText("Account");
		expect(label.getAttribute("data-slot")).toBe("dropdown-menu-label");
		expect(label.getAttribute("data-inset")).toBe("true");
		const shortcut = body.getByText("⌘S");
		expect(shortcut.getAttribute("data-slot")).toBe("dropdown-menu-shortcut");
		expect(shortcut.className).toContain("custom-shortcut");
		expect(body.getByRole("separator").getAttribute("data-slot")).toBe(
			"dropdown-menu-separator",
		);
	});

	test("checkbox item toggles its checked state and reports it", async () => {
		const user = userEvent.setup({ document });
		const onCheckedChange = mock();
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuCheckboxItem
						inset
						defaultChecked={false}
						onCheckedChange={onCheckedChange}
						closeOnClick={false}
					>
						Status bar
					</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const item = body.getByRole("menuitemcheckbox", { name: "Status bar" });
		expect(item.getAttribute("aria-checked")).toBe("false");
		expect(item.getAttribute("data-inset")).toBe("true");
		await user.click(item);
		expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
		expect(item.getAttribute("aria-checked")).toBe("true");
	});

	test("controlled checked checkbox item shows the check indicator", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuCheckboxItem checked>Panel</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const item = body.getByRole("menuitemcheckbox", { name: "Panel" });
		expect(item.getAttribute("aria-checked")).toBe("true");
		const indicator = item.querySelector(
			'[data-slot="dropdown-menu-checkbox-item-indicator"]',
		);
		expect(indicator?.querySelector("svg")).not.toBeNull();
	});

	test("radio items select one value at a time", async () => {
		const user = userEvent.setup({ document });
		const onValueChange = mock();
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuRadioGroup
						defaultValue="top"
						onValueChange={onValueChange}
					>
						<DropdownMenuRadioItem value="top" closeOnClick={false}>
							Top
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="bottom" inset closeOnClick={false}>
							Bottom
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const top = body.getByRole("menuitemradio", { name: "Top" });
		const bottom = body.getByRole("menuitemradio", { name: "Bottom" });
		expect(top.getAttribute("aria-checked")).toBe("true");
		expect(bottom.getAttribute("data-inset")).toBe("true");
		await user.click(bottom);
		expect(onValueChange.mock.calls[0]?.[0]).toBe("bottom");
		expect(bottom.getAttribute("aria-checked")).toBe("true");
		expect(top.getAttribute("aria-checked")).toBe("false");
	});

	test("sub trigger opens the submenu content", async () => {
		const user = userEvent.setup({ document });
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="custom-sub">
							<DropdownMenuItem>Nested</DropdownMenuItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		const subTrigger = body.getByRole("menuitem", { name: "More" });
		expect(subTrigger.getAttribute("data-slot")).toBe(
			"dropdown-menu-sub-trigger",
		);
		expect(subTrigger.getAttribute("data-inset")).toBe("true");
		await user.click(subTrigger);
		const nested = await body.findByRole("menuitem", { name: "Nested" });
		const sub = nested.closest('[data-slot="dropdown-menu-sub-content"]');
		expect(sub).not.toBeNull();
		expect(sub?.className).toContain("custom-sub");
	});

	test("portal renders popup content into document.body", () => {
		const view = render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuPortal>
					<MenuPrimitive.Positioner>
						<MenuPrimitive.Popup>
							<DropdownMenuItem>Portaled</DropdownMenuItem>
						</MenuPrimitive.Popup>
					</MenuPrimitive.Positioner>
				</DropdownMenuPortal>
			</DropdownMenu>,
		);
		const item = body.getByRole("menuitem", { name: "Portaled" });
		expect(view.container.contains(item)).toBe(false);
	});
});
