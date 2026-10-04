import "../test/setup";

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, installDom, render } from "../test/dom";

import { guideWords, lockedGuide } from "./guide";
import { type Guide, GuideCue, SPEAK_AFTER_MS } from "./guide-cue";

installDom();

let calls: string[] = [];
beforeEach(() => {
	calls = [];
	jest.useFakeTimers();
	Object.assign(globalThis, {
		speechSynthesis: {
			cancel: () => calls.push("cancel"),
			speak: (u: { text: string }) => calls.push(`say ${u.text}`),
		},
		SpeechSynthesisUtterance: class {
			constructor(readonly text: string) {}
		},
	});
});
afterEach(() => jest.useRealTimers());

const FRAME = { width: 480, height: 640 };
const cases: [string, Guide][] = [
	["locked ahead", lockedGuide({ x: 240, y: 320 }, FRAME)],
	["left", lockedGuide({ x: 60, y: 320 }, FRAME)],
	["right", lockedGuide({ x: 420, y: 320 }, FRAME)],
	["behind", { angle: 0, words: guideWords(0, true) }],
	[
		"lost, off the left edge",
		{ angle: Math.PI, words: guideWords(Math.PI, false) },
	],
];

test.each(cases)("the voice says the drawn guide (%s)", (_, guide) => {
	const view = render(<GuideCue big guide={guide} voice />);
	const drawn = view.container.querySelector("p")?.textContent;
	act(() => jest.advanceTimersByTime(SPEAK_AFTER_MS));
	expect(calls).toEqual(["cancel", `say ${drawn}`]);
	expect(drawn).toBe(guide.words);
});

test("a direction that does not stay is never said, and a change stops old speech", () => {
	const left = lockedGuide({ x: 60, y: 320 }, FRAME);
	const right = lockedGuide({ x: 420, y: 320 }, FRAME);
	const view = render(<GuideCue big={false} guide={left} voice />);
	act(() => jest.advanceTimersByTime(SPEAK_AFTER_MS - 100));
	view.rerender(<GuideCue big={false} guide={right} voice />);
	act(() => jest.advanceTimersByTime(SPEAK_AFTER_MS));
	expect(calls).toEqual(["cancel", "cancel", "say Turn right"]);
	view.rerender(<GuideCue big={false} guide={null} voice />);
	act(() => jest.advanceTimersByTime(SPEAK_AFTER_MS));
	expect(calls.at(-1)).toBe("cancel");
	expect(view.container.textContent).toBe("");
});

test("with the voice off, nothing is said", () => {
	render(
		<GuideCue
			big
			guide={lockedGuide({ x: 240, y: 320 }, FRAME)}
			voice={false}
		/>,
	);
	act(() => jest.advanceTimersByTime(SPEAK_AFTER_MS * 2));
	expect(calls).toEqual([]);
});
