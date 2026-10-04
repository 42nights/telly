import "../test/setup";

import { describe, expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { installDom, render } from "../test/dom";

import { ApiNotice, Tip } from ".";

installDom();

/** `Link` needs a router: renders `ui` as the root route of an in-memory one. */
const inRouter = (ui: ReactNode) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory(),
	});
	return render(<RouterProvider router={router} />);
};

describe("Tip", () => {
	test("names the button with its text and keeps it centered by default", () => {
		const view = render(<Tip text="Readings come from the watch." />);
		const button = view.getByRole("button", {
			name: "Readings come from the watch.",
		});
		expect(button.dataset.tip).toBe("Readings come from the watch.");
		expect(button.dataset.align).toBe("center");
		expect(button.getAttribute("type")).toBe("button");
	});

	test("aligns to the end at a right edge", () => {
		const view = render(<Tip align="end" text="Edge" />);
		expect(view.getByRole("button", { name: "Edge" }).dataset.align).toBe(
			"end",
		);
	});
});

describe("ApiNotice", () => {
	test("loading is a calm status that waits for the server", () => {
		const view = render(
			<ApiNotice state={{ kind: "loading" }} what="alerts" />,
		);
		const status = view.getByRole("status");
		expect(status.textContent).toContain("Loading alerts…");
		expect(status.textContent).toContain("Waiting for the server.");
	});

	test("signed out asks the user to sign in and links to the sign-in page", async () => {
		const view = inRouter(
			<ApiNotice state={{ kind: "signed_out" }} what="alerts" />,
		);
		const link = await view.findByRole("link", { name: "Go to Sign in" });
		expect(link.getAttribute("href")).toBe("/sign-in");
		const status = view.getByRole("status");
		expect(status.textContent).toContain("Sign-in required");
		expect(status.textContent).toContain("Sign in to see alerts.");
	});

	test("forbidden is a calm notice without the server's message", () => {
		const view = render(
			<ApiNotice
				state={{ kind: "forbidden", message: "Ask a member to add you." }}
				what="alerts"
			/>,
		);
		expect(view.queryByRole("alert")).toBeNull();
		const status = view.getByRole("status");
		expect(status.textContent).toContain("Not shared with you");
		expect(status.textContent).not.toContain("Ask a member to add you.");
	});

	test.each([
		[
			{ kind: "unavailable", message: "The database is down." } as const,
			"Alerts unavailable",
		],
		[{ kind: "error", message: "HTTP 500" } as const, "Could not load alerts"],
	])("a %p failure is an alert with the server's message", (state, title) => {
		const view = render(<ApiNotice state={state} what="alerts" />);
		const alert = view.getByRole("alert");
		expect(alert.textContent).toContain(title);
		expect(alert.textContent).toContain(state.message);
		expect(view.queryByRole("link")).toBeNull();
	});
});
