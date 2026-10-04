// First: registers Happy DOM before React DOM and the router load.
import "./test/dom";

import { expect, test } from "bun:test";

import Header from "./header";
import { act, renderRouted, setupDom, signIn } from "./test/dom";

setupDom();

test("signed out, the taskbar offers Sign in and marks the current screen pressed", async () => {
	const { view } = await renderRouted(<Header />, "/family");
	const family = await view.findByRole("link", { name: "Family" });
	expect(family.getAttribute("aria-current")).toBe("page");
	expect(
		view.getByRole("link", { name: "Home" }).getAttribute("aria-current"),
	).toBeNull();
	expect(view.getByRole("link", { name: "Sign in" })).toBeDefined();
	expect(view.queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("signed in, Sign out clears the session and the taskbar follows", async () => {
	signIn();
	const { view } = await renderRouted(<Header />, "/hud");
	const signOut = await view.findByRole("button", { name: "Sign out" });
	act(() => signOut.click());
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
	expect(await view.findByRole("link", { name: "Sign in" })).toBeDefined();
});
