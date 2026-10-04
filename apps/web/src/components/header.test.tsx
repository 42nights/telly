// First: registers Happy DOM before React DOM and the router load.
import "./test/dom";

import { expect, test } from "bun:test";

import Header from "./header";
import { act, renderRouted, setupDom, signIn } from "./test/dom";

setupDom();

test("the taskbar marks the current screen pressed and offers no Sign in", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/family");
	const family = await view.findByRole("link", { name: "Family" });
	expect(family.getAttribute("aria-current")).toBe("page");
	expect(
		view.getByRole("link", { name: "Home" }).getAttribute("aria-current"),
	).toBeNull();
	expect(view.queryByRole("link", { name: "Sign in" })).toBeNull();
});

test("Sign out ends the session", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/hud");
	const signOut = await view.findByRole("button", { name: "Sign out" });
	act(() => signOut.click());
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});
