// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import { Heart } from "lucide-react";

import { render, setupDom } from "../test/dom-routed";
import { Window } from "./window";

setupDom();

test("a window is a region named by its title bar, with no window buttons", () => {
	const view = render(
		<Window icon={Heart} title="Vitals">
			<p>72 bpm</p>
		</Window>,
	);
	const region = view.getByRole("region", { name: "Vitals" });
	expect(view.getByRole("heading", { name: "Vitals" })).toBeDefined();
	expect(region.textContent).toContain("72 bpm");
	expect(view.queryByRole("button")).toBeNull();
	expect(region.querySelectorAll("p")).toHaveLength(1);
});

test("a status shows in a status bar under the body", () => {
	const view = render(
		<Window icon={Heart} status="Updated just now" title="Vitals">
			<p>72 bpm</p>
		</Window>,
	);
	const region = view.getByRole("region", { name: "Vitals" });
	expect(region.lastElementChild?.textContent).toBe("Updated just now");
});
