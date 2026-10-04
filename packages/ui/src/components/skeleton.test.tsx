import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import { Skeleton } from "@health/ui/components/skeleton";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Skeleton", () => {
	test("renders a skeleton slot that forwards props and merges className", () => {
		const view = render(<Skeleton aria-label="loading" className="h-4" />);
		const el = view.getByLabelText("loading");
		expect(el.getAttribute("data-slot")).toBe("skeleton");
		expect(el.className).toContain("h-4");
		expect(el.className).toContain("animate-pulse");
	});
});
