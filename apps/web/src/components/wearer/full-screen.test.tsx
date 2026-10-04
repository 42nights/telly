import "../test/setup";

import { expect, test } from "bun:test";
import { fireEvent, installDom, render } from "../test/dom";

import { FullScreenButton, useFullScreen } from "./full-screen";

installDom();

function Finder() {
	const screen = useFullScreen<HTMLDivElement>();
	return (
		<div
			className={screen.full ? "full" : "normal"}
			data-testid="frame"
			{...screen.frame}
		>
			<FullScreenButton full={screen.full} toggle={screen.toggle} />
		</div>
	);
}

const swipe = (el: Element, dx: number, dy: number) => {
	fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
	fireEvent.touchEnd(el, {
		changedTouches: [{ clientX: 100 + dx, clientY: 100 + dy }],
	});
};

test("the button, Escape, and a swipe down leave full screen; other swipes do not", () => {
	const view = render(<Finder />);
	const frame = view.getByTestId("frame");
	const enter = () =>
		fireEvent.click(view.getByRole("button", { name: "Full screen" }));

	enter();
	expect(frame.className).toBe("full");
	fireEvent.click(view.getByRole("button", { name: "Exit full screen" }));
	expect(frame.className).toBe("normal");

	enter();
	fireEvent.keyDown(window, { key: "Escape" });
	expect(frame.className).toBe("normal");

	enter();
	// Too short, sideways, or upward: still full screen.
	swipe(frame, 0, 40);
	swipe(frame, 150, 100);
	swipe(frame, 0, -200);
	expect(frame.className).toBe("full");
	swipe(frame, 10, 120);
	expect(frame.className).toBe("normal");
});
