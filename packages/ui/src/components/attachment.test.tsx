import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
	AttachmentTrigger,
} from "@health/ui/components/attachment";
import { installDom } from "@health/ui/test/dom";
import { fireEvent, render } from "@testing-library/react";

installDom();

describe("Attachment", () => {
	test("defaults state, size and orientation data attributes", () => {
		const view = render(<Attachment data-testid="a" />);
		const el = view.getByTestId("a");
		expect(el.getAttribute("data-slot")).toBe("attachment");
		expect(el.getAttribute("data-state")).toBe("done");
		expect(el.getAttribute("data-size")).toBe("default");
		expect(el.getAttribute("data-orientation")).toBe("horizontal");
	});

	test("reflects state, size and orientation props", () => {
		const view = render(
			<Attachment
				data-testid="a"
				state="error"
				size="xs"
				orientation="vertical"
			/>,
		);
		const el = view.getByTestId("a");
		expect(el.getAttribute("data-state")).toBe("error");
		expect(el.getAttribute("data-size")).toBe("xs");
		expect(el.getAttribute("data-orientation")).toBe("vertical");
		expect(el.className).toContain("flex-col");
	});

	test("null orientation falls back to horizontal", () => {
		const view = render(<Attachment data-testid="a" orientation={null} />);
		expect(view.getByTestId("a").getAttribute("data-orientation")).toBe(
			"horizontal",
		);
	});

	test("caller className is merged", () => {
		const view = render(<Attachment data-testid="a" className="w-64" />);
		const cls = view.getByTestId("a").className;
		expect(cls).toContain("w-64");
		expect(cls).not.toContain("w-fit");
	});
});

describe("Attachment parts", () => {
	test("render their slots with content", () => {
		const view = render(
			<AttachmentGroup data-testid="g">
				<Attachment>
					<AttachmentMedia data-testid="m" />
					<AttachmentContent data-testid="c">
						<AttachmentTitle>file.pdf</AttachmentTitle>
						<AttachmentDescription>2 MB</AttachmentDescription>
					</AttachmentContent>
					<AttachmentActions data-testid="x" />
				</Attachment>
			</AttachmentGroup>,
		);
		expect(view.getByTestId("g").getAttribute("data-slot")).toBe(
			"attachment-group",
		);
		expect(view.getByTestId("m").getAttribute("data-variant")).toBe("icon");
		expect(view.getByTestId("c").getAttribute("data-slot")).toBe(
			"attachment-content",
		);
		expect(view.getByText("file.pdf").getAttribute("data-slot")).toBe(
			"attachment-title",
		);
		expect(view.getByText("2 MB").getAttribute("data-slot")).toBe(
			"attachment-description",
		);
		expect(view.getByTestId("x").getAttribute("data-slot")).toBe(
			"attachment-actions",
		);
	});

	test("image media variant is reflected", () => {
		const view = render(<AttachmentMedia data-testid="m" variant="image" />);
		const el = view.getByTestId("m");
		expect(el.getAttribute("data-variant")).toBe("image");
		expect(el.className).toContain("opacity-60");
	});
});

describe("AttachmentAction", () => {
	test("is a non-submitting button that fires onClick", () => {
		let clicks = 0;
		const view = render(
			<AttachmentAction aria-label="Remove" onClick={() => clicks++} />,
		);
		const btn = view.getByRole("button", { name: "Remove" });
		expect(btn.getAttribute("type")).toBe("button");
		expect(btn.getAttribute("data-slot")).toBe("attachment-action");
		fireEvent.click(btn);
		expect(clicks).toBe(1);
	});

	test("caller type overrides the default", () => {
		const view = render(<AttachmentAction aria-label="Go" type="submit" />);
		expect(view.getByRole("button").getAttribute("type")).toBe("submit");
	});
});

describe("AttachmentTrigger", () => {
	test("defaults to a button of type button that fires onClick", () => {
		let clicks = 0;
		const view = render(
			<AttachmentTrigger
				aria-label="Open"
				className="rounded"
				onClick={() => clicks++}
			/>,
		);
		const btn = view.getByRole("button", { name: "Open" });
		expect(btn.getAttribute("type")).toBe("button");
		expect(btn.getAttribute("data-slot")).toBe("attachment-trigger");
		expect(btn.className).toContain("rounded");
		fireEvent.click(btn);
		expect(clicks).toBe(1);
	});

	test("render prop element gets no implicit type", () => {
		const view = render(
			<AttachmentTrigger render={<a href="/f" />} aria-label="Open" />,
		);
		const link = view.getByRole("link", { name: "Open" });
		expect(link.hasAttribute("type")).toBe(false);
	});
});
