import "./test/setup";

import { expect, test } from "bun:test";
import Loader from "./loader";
import { installDom, render } from "./test/dom";

installDom();

test("shows one spinning icon while a page loads", () => {
	const view = render(<Loader />);
	const icons = view.container.querySelectorAll("svg");
	expect(icons).toHaveLength(1);
	expect(icons[0]?.classList.contains("animate-spin")).toBe(true);
});
