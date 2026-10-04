import "@health/ui/test/register";

import { describe, expect, mock, test } from "bun:test";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@health/ui/components/message-scroller";
import { installDom } from "@health/ui/test/dom";
import { act, fireEvent, render } from "@testing-library/react";
import type * as React from "react";

installDom();

function Chat({ children }: { children?: React.ReactNode }) {
	return (
		<MessageScrollerProvider>
			<MessageScroller className="root-custom">
				<MessageScrollerViewport className="viewport-custom">
					<MessageScrollerContent className="content-custom">
						<MessageScrollerItem messageId="m1" className="item-custom">
							first
						</MessageScrollerItem>
						<MessageScrollerItem messageId="m2" scrollAnchor>
							second
						</MessageScrollerItem>
					</MessageScrollerContent>
				</MessageScrollerViewport>
				{children}
			</MessageScroller>
		</MessageScrollerProvider>
	);
}

/** happy-dom has no layout: give the viewport 100px of view over 1000px of messages. */
function layOut(viewport: HTMLElement, item: HTMLElement, scrollTop: number) {
	Object.defineProperty(viewport, "clientHeight", {
		configurable: true,
		value: 100,
	});
	Object.defineProperty(viewport, "scrollHeight", {
		configurable: true,
		value: 1000,
	});
	viewport.scrollTop = scrollTop;
	item.getBoundingClientRect = () => new DOMRect(0, 900, 100, 100);
}

describe("MessageScroller", () => {
	test("renders slotted parts with caller classNames merged", () => {
		const view = render(<Chat />);
		const viewport = view.getByRole("region", { name: "Messages" });
		expect(viewport.dataset.slot).toBe("message-scroller-viewport");
		expect(viewport.className).toContain("viewport-custom");
		const root = viewport.parentElement as HTMLElement;
		expect(root.dataset.slot).toBe("message-scroller");
		expect(root.className).toContain("root-custom");
		const item = view.getByText("first");
		expect(item.dataset.slot).toBe("message-scroller-item");
		expect(item.className).toContain("item-custom");
		const content = item.parentElement as HTMLElement;
		expect(content.dataset.slot).toBe("message-scroller-content");
		expect(content.className).toContain("content-custom");
	});

	test("items are not scroll anchors unless asked", () => {
		const view = render(<Chat />);
		expect(view.getByText("first").dataset.scrollAnchor).toBe("false");
		expect(view.getByText("second").dataset.scrollAnchor).toBe("true");
	});
});

describe("MessageScrollerButton", () => {
	test("defaults to a secondary icon button labelled for the end", () => {
		const view = render(
			<Chat>
				<MessageScrollerButton />
			</Chat>,
		);
		const button = view.getByRole("button", {
			name: "Scroll to end",
			hidden: true,
		});
		expect(button.dataset.slot).toBe("message-scroller-button");
		expect(button.dataset.direction).toBe("end");
		expect(button.dataset.variant).toBe("secondary");
		expect(button.dataset.size).toBe("icon-sm");
	});

	test("is inactive when there is nothing to scroll to", () => {
		const view = render(
			<Chat>
				<MessageScrollerButton />
			</Chat>,
		);
		const button = view.getByRole("button", {
			name: "Scroll to end",
			hidden: true,
		});
		expect(button.dataset.active).toBe("false");
		expect(button.tabIndex).toBe(-1);
	});

	test("becomes active after scrolling away from the end and scrolls back on click", () => {
		const view = render(
			<Chat>
				<MessageScrollerButton />
			</Chat>,
		);
		const viewport = view.getByRole("region", { name: "Messages" });
		const scrollTo = mock((_options: ScrollToOptions) => {});
		viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
		layOut(viewport, view.getByText("second"), 0);
		act(() => {
			fireEvent.scroll(viewport);
		});
		const button = view.getByRole("button", { name: "Scroll to end" });
		expect(button.dataset.active).toBe("true");
		fireEvent.click(button);
		expect(scrollTo).toHaveBeenCalled();
		expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ top: 900 });
	});

	test("start direction is labelled for the start and scrolls to the top", () => {
		const view = render(
			<Chat>
				<MessageScrollerButton direction="start" />
			</Chat>,
		);
		const viewport = view.getByRole("region", { name: "Messages" });
		const scrollTo = mock((_options: ScrollToOptions) => {});
		viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
		layOut(viewport, view.getByText("second"), 500);
		act(() => {
			fireEvent.scroll(viewport);
		});
		const button = view.getByRole("button", { name: "Scroll to start" });
		expect(button.dataset.direction).toBe("start");
		expect(button.dataset.active).toBe("true");
		fireEvent.click(button);
		expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ top: 0 });
	});

	test("custom children, variant and render replace the defaults", () => {
		const view = render(
			<Chat>
				<MessageScrollerButton
					variant="outline"
					size="sm"
					className="btn-custom"
					render={<button type="button" data-custom="yes" />}
				>
					Newest
				</MessageScrollerButton>
			</Chat>,
		);
		const button = view.getByRole("button", { name: "Newest", hidden: true });
		expect(button.dataset.custom).toBe("yes");
		expect(button.dataset.variant).toBe("outline");
		expect(button.dataset.size).toBe("sm");
		expect(button.className).toContain("btn-custom");
	});
});
