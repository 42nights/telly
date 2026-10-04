import "@health/ui/test/register";

import { describe, expect, test } from "bun:test";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@health/ui/components/empty";
import { installDom } from "@health/ui/test/dom";
import { render } from "@testing-library/react";

installDom();

describe("Empty", () => {
	test("renders a composed empty state with slots", () => {
		const view = render(
			<Empty className="outer">
				<EmptyHeader>
					<EmptyMedia>media</EmptyMedia>
					<EmptyTitle>No results</EmptyTitle>
					<EmptyDescription>Try again</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>actions</EmptyContent>
			</Empty>,
		);
		expect(view.getByText("No results").dataset.slot).toBe("empty-title");
		expect(view.getByText("Try again").dataset.slot).toBe("empty-description");
		expect(view.getByText("actions").dataset.slot).toBe("empty-content");
		const header = view.getByText("media").parentElement;
		expect(header?.dataset.slot).toBe("empty-header");
		expect(header?.parentElement?.dataset.slot).toBe("empty");
		expect(header?.parentElement?.classList.contains("outer")).toBe(true);
	});

	test("EmptyMedia defaults to the default variant", () => {
		const view = render(<EmptyMedia>m</EmptyMedia>);
		const media = view.getByText("m");
		expect(media.dataset.slot).toBe("empty-icon");
		expect(media.dataset.variant).toBe("default");
		expect(media.classList.contains("bg-transparent")).toBe(true);
	});

	test("EmptyMedia icon variant uses the muted icon tile", () => {
		const view = render(
			<EmptyMedia variant="icon" className="extra">
				m
			</EmptyMedia>,
		);
		const media = view.getByText("m");
		expect(media.dataset.variant).toBe("icon");
		expect(media.classList.contains("bg-muted")).toBe(true);
		expect(media.classList.contains("extra")).toBe(true);
	});
});
