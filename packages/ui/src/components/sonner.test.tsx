import "@health/ui/test/register";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Toaster } from "@health/ui/components/sonner";
import { installDom } from "@health/ui/test/dom";
import { act, render, within } from "@testing-library/react";
import { toast } from "sonner";

installDom();
afterEach(() => {
	act(() => toast.dismiss());
	return Bun.sleep(0);
});

const body = within(document.body);

describe("Toaster", () => {
	test("shows a toast message passed to toast()", async () => {
		render(<Toaster />);
		act(() => {
			toast("Saved changes");
		});
		const message = await body.findByText("Saved changes");
		expect(message.closest("[data-sonner-toast]")?.className).toContain(
			"cn-toast",
		);
	});

	test("uses the custom success icon for success toasts", async () => {
		render(<Toaster />);
		act(() => {
			toast.success("All good");
		});
		const toastEl = (await body.findByText("All good")).closest(
			"[data-sonner-toast]",
		);
		expect(toastEl?.getAttribute("data-type")).toBe("success");
		expect(
			toastEl?.querySelector("[data-icon] svg.lucide-circle-check"),
		).not.toBeNull();
	});

	test("defaults to the system theme and follows the OS dark preference", async () => {
		const matchMedia = spyOn(window, "matchMedia").mockImplementation(
			(query: string) =>
				({
					matches: query === "(prefers-color-scheme: dark)",
					media: query,
					addEventListener() {},
					removeEventListener() {},
					addListener() {},
					removeListener() {},
				}) as unknown as MediaQueryList,
		);
		try {
			render(<Toaster />);
			act(() => {
				toast("Dark toast");
			});
			await body.findByText("Dark toast");
			expect(
				document
					.querySelector("[data-sonner-toaster]")
					?.getAttribute("data-sonner-theme"),
			).toBe("dark");
		} finally {
			matchMedia.mockRestore();
		}
	});

	test("caller props override the defaults", async () => {
		render(<Toaster theme="light" position="top-center" />);
		act(() => {
			toast("Placed toast");
		});
		await body.findByText("Placed toast");
		const toaster = document.querySelector("[data-sonner-toaster]");
		expect(toaster?.getAttribute("data-sonner-theme")).toBe("light");
		expect(toaster?.getAttribute("data-y-position")).toBe("top");
		expect(toaster?.getAttribute("data-x-position")).toBe("center");
	});
});
