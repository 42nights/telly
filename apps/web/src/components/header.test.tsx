// First: registers Happy DOM before React DOM and the router load.
import "./test/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";

import Header from "./header";
import { act, renderRouted, setupDom, signIn } from "./test/dom";

setupDom();

// Happy DOM has no popover API; record which popovers the taskbar closes.
let hidden: string[] = [];
beforeEach(() => {
	hidden = [];
	HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
		hidden.push(this.id);
	};
});
afterEach(() => Reflect.deleteProperty(HTMLElement.prototype, "hidePopover"));

test("the bar marks the current screen pressed; More stays raised for bar screens", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/family");
	const family = await view.findByRole("link", { name: "Family" });
	expect(family.getAttribute("aria-current")).toBe("page");
	expect(
		view.getByRole("link", { name: "Home" }).getAttribute("aria-current"),
	).toBeNull();
	expect(
		view.getByRole("button", { name: "More" }).hasAttribute("data-current"),
	).toBe(false);
	expect(view.queryByRole("link", { name: "Sign in" })).toBeNull();
});

test("on a More screen, More shows pressed and choosing a screen closes the menu", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/bedtime");
	const more = await view.findByRole("button", { name: "More" });
	expect(more.getAttribute("data-current")).toBe("true");
	const visits = view.getByRole("link", { name: "Visits", hidden: true });
	act(() => visits.click());
	expect(hidden).toEqual(["more-screens"]);
});

test("Sign out closes the menu and ends the session", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/hud");
	const signOut = await view.findByRole("button", {
		name: "Sign out",
		hidden: true,
	});
	act(() => signOut.click());
	expect(hidden).toEqual(["more-screens"]);
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});

const toggle = (target: Element, newState: "open" | "closed") =>
	act(() => {
		target.dispatchEvent(
			Object.assign(new Event("beforetoggle"), { newState, oldState: "" }),
		);
	});

test("the More menu opens under the More button and stays on screen", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/hud");
	const more = await view.findByRole("button", { name: "More" });
	const menu = view.container.querySelector("#more-screens") as HTMLElement;
	const at = (left: number) => {
		more.getBoundingClientRect = () =>
			({ left, bottom: 52 }) as unknown as DOMRect;
	};
	at(100);
	toggle(menu, "open");
	expect([menu.style.top, menu.style.left]).toEqual(["52px", "100px"]);
	// Near the right edge, the 192 px menu moves left so it still fits.
	at(window.innerWidth - 50);
	toggle(menu, "open");
	expect(menu.style.left).toBe(`${window.innerWidth - 192 - 4}px`);
	// Closing does not move it.
	at(10);
	toggle(menu, "closed");
	expect(menu.style.left).toBe(`${window.innerWidth - 192 - 4}px`);
});
