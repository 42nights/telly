import "../test/setup";

import { afterEach, expect, jest, test } from "bun:test";
import { act, installDom, render } from "../test/dom";

import { useNow } from "./use-now";

installDom();

afterEach(() => {
	jest.useRealTimers();
});

function Clock() {
	return <time>{useNow()}</time>;
}

test("starts at the current time and moves on each second until unmounted", () => {
	const start = Date.parse("2026-01-01T08:00:00Z");
	jest.useFakeTimers({ now: start });
	const view = render(<Clock />);
	const shown = () => Number(view.container.textContent);
	expect(shown()).toBe(start);
	act(() => jest.advanceTimersByTime(999));
	expect(shown()).toBe(start);
	act(() => jest.advanceTimersByTime(1));
	expect(shown()).toBe(start + 1_000);
	act(() => jest.advanceTimersByTime(2_000));
	expect(shown()).toBe(start + 3_000);
	expect(jest.getTimerCount()).toBe(1);
	view.unmount();
	expect(jest.getTimerCount()).toBe(0);
});
