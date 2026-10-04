import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageGroup,
	MessageHeader,
} from "@health/ui/components/message";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Message", () => {
	test("aligns to the start by default", () => {
		const view = render(<Message>m</Message>);
		const message = view.getByText("m");
		expect(message.dataset.slot).toBe("message");
		expect(message.dataset.align).toBe("start");
	});

	test("align end is exposed for styling", () => {
		const view = render(<Message align="end">m</Message>);
		expect(view.getByText("m").dataset.align).toBe("end");
	});

	test("merges caller className and forwards props", () => {
		const view = render(
			<Message className="custom" aria-label="From Ana">
				m
			</Message>,
		);
		const message = view.getByLabelText("From Ana");
		expect(message.className).toContain("custom");
	});
});

describe("message parts", () => {
	test.each([
		["message-group", MessageGroup],
		["message-avatar", MessageAvatar],
		["message-content", MessageContent],
		["message-header", MessageHeader],
		["message-footer", MessageFooter],
	] as const)("%s renders its slot and merges className", (slot, Part) => {
		const view = render(
			<Part className="custom" title="t">
				part
			</Part>,
		);
		const el = view.getByText("part");
		expect(el.dataset.slot).toBe(slot);
		expect(el.className).toContain("custom");
		expect(el.getAttribute("title")).toBe("t");
	});
});
