import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Bubble,
	BubbleContent,
	BubbleGroup,
	BubbleReactions,
} from "@health/ui/components/bubble";
import { installDom } from "@health/ui/test/dom";
import { fireEvent, render } from "@testing-library/react";

installDom();

describe("Bubble", () => {
	test("defaults to the default variant aligned to the start", () => {
		const view = render(<Bubble>hi</Bubble>);
		const bubble = view.getByText("hi");
		expect(bubble.dataset.slot).toBe("bubble");
		expect(bubble.dataset.variant).toBe("default");
		expect(bubble.dataset.align).toBe("start");
	});

	test("reflects variant and align props as data attributes", () => {
		const view = render(
			<Bubble variant="ghost" align="end">
				hi
			</Bubble>,
		);
		const bubble = view.getByText("hi");
		expect(bubble.dataset.variant).toBe("ghost");
		expect(bubble.dataset.align).toBe("end");
	});

	test("the variant selects a different content style", () => {
		const view = render(
			<>
				<Bubble variant="destructive">bad</Bubble>
				<Bubble variant="muted">quiet</Bubble>
			</>,
		);
		expect(view.getByText("bad").className).toContain("bg-destructive/10");
		expect(view.getByText("quiet").className).not.toContain("bg-destructive");
	});

	test("merges caller className and forwards props", () => {
		const view = render(
			<Bubble className="custom" title="tip">
				hi
			</Bubble>,
		);
		const bubble = view.getByText("hi");
		expect(bubble.className).toContain("custom");
		expect(bubble.getAttribute("title")).toBe("tip");
	});
});

describe("BubbleGroup", () => {
	test("renders a bubble-group slot with caller className", () => {
		const view = render(<BubbleGroup className="custom">g</BubbleGroup>);
		const group = view.getByText("g");
		expect(group.dataset.slot).toBe("bubble-group");
		expect(group.className).toContain("custom");
	});
});

describe("BubbleContent", () => {
	test("renders a div with the bubble-content slot by default", () => {
		const view = render(<BubbleContent className="custom">text</BubbleContent>);
		const content = view.getByText("text");
		expect(content.tagName).toBe("DIV");
		expect(content.dataset.slot).toBe("bubble-content");
		expect(content.className).toContain("custom");
	});

	test("renders as the element given in render and keeps its handlers", () => {
		let clicks = 0;
		const view = render(
			<BubbleContent
				render={<button type="button" />}
				onClick={() => {
					clicks += 1;
				}}
			>
				Reply
			</BubbleContent>,
		);
		const button = view.getByRole("button", { name: "Reply" });
		expect(button.dataset.slot).toBe("bubble-content");
		fireEvent.click(button);
		expect(clicks).toBe(1);
	});
});

describe("BubbleReactions", () => {
	test("defaults to bottom end placement", () => {
		const view = render(<BubbleReactions>👍</BubbleReactions>);
		const reactions = view.getByText("👍");
		expect(reactions.dataset.slot).toBe("bubble-reactions");
		expect(reactions.dataset.side).toBe("bottom");
		expect(reactions.dataset.align).toBe("end");
		expect(reactions.className).toContain("translate-y-3/4");
		expect(reactions.className).toContain("right-3");
	});

	test("side and align props move the reactions", () => {
		const view = render(
			<BubbleReactions side="top" align="start" className="custom">
				👍
			</BubbleReactions>,
		);
		const reactions = view.getByText("👍");
		expect(reactions.dataset.side).toBe("top");
		expect(reactions.dataset.align).toBe("start");
		expect(reactions.className).toContain("-translate-y-3/4");
		expect(reactions.className).toContain("left-3");
		expect(reactions.className).toContain("custom");
	});
});
