import "./test/setup";

import { afterEach, describe, expect, test } from "bun:test";
import { useTheme } from "next-themes";
import { act, installDom, render, waitFor } from "./test/dom";

import { ThemeProvider } from "./theme-provider";

installDom();

const root = () => document.documentElement;

afterEach(() => {
	root().className = "";
	root().removeAttribute("data-theme");
	root().style.colorScheme = "";
});

function Switch() {
	const { setTheme } = useTheme();
	return (
		<>
			<button onClick={() => setTheme("dark")} type="button">
				Dark
			</button>
			<button onClick={() => setTheme("light")} type="button">
				Light
			</button>
		</>
	);
}

function App() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			disableTransitionOnChange
			storageKey="vite-ui-theme"
		>
			<Switch />
		</ThemeProvider>
	);
}

describe("ThemeProvider", () => {
	test("with the app's options, puts the default theme on the page as a class", async () => {
		const view = render(<App />);
		await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
		expect(root().style.colorScheme).toBe("dark");
		expect(view.getByRole("button", { name: "Light" })).toBeDefined();
	});

	test("the theme saved on this device wins over the default", async () => {
		localStorage.setItem("vite-ui-theme", "light");
		render(<App />);
		await waitFor(() => expect(root().classList.contains("light")).toBe(true));
		expect(root().classList.contains("dark")).toBe(false);
	});

	test("a switch replaces the class and saves the choice on this device", async () => {
		const view = render(<App />);
		await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
		await act(async () => view.getByRole("button", { name: "Light" }).click());
		await waitFor(() => expect(root().classList.contains("light")).toBe(true));
		expect(root().classList.contains("dark")).toBe(false);
		expect(localStorage.getItem("vite-ui-theme")).toBe("light");
		await act(async () => view.getByRole("button", { name: "Dark" }).click());
		await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
		expect(localStorage.getItem("vite-ui-theme")).toBe("dark");
	});

	test("passes its options through, such as a data attribute instead of a class", async () => {
		render(
			<ThemeProvider attribute="data-theme" forcedTheme="dark">
				<p>child</p>
			</ThemeProvider>,
		);
		await waitFor(() => expect(root().getAttribute("data-theme")).toBe("dark"));
		expect(root().classList.contains("dark")).toBe(false);
	});
});
