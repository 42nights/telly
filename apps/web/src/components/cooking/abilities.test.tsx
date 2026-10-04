// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { expect, test } from "bun:test";
import type { CookingProfileRecord } from "@health/contracts/cooking";
import type { RenderResult } from "@testing-library/react";

import {
	fireEvent,
	render,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom";
import { CookingAbilities } from "./abilities";

setupDom();

const PATH = "/api/families/f1/cooking/profile";

const empty: CookingProfileRecord = {
	profile: null,
	editedBy: null,
	editedAt: null,
};

const recorded: CookingProfileRecord = {
	profile: {
		tasks: {
			stove: "alone",
			oven: "not_allowed",
			microwave: "alone",
			toaster: "alone",
			knife: "with_helper",
		},
		dislikes: ["liver", "okra"],
	},
	editedBy: "a".repeat(64),
	editedAt: "2026-01-02T08:00:00.000Z",
};

const select = (view: RenderResult, name: string) =>
	view.getByRole("combobox", { name }) as HTMLSelectElement;

test("with nothing recorded, every task asks for a helper; a save sends the cleaned profile and reloads it", async () => {
	signIn();
	let current = empty;
	const calls = serve({
		[`GET ${PATH}`]: () => ({ json: current }),
		[`PUT ${PATH}`]: ({ body }) => {
			current = {
				profile: body as CookingProfileRecord["profile"],
				editedBy: "b".repeat(64),
				editedAt: "2026-03-04T09:00:00.000Z",
			};
			return { status: 204 };
		},
	});
	const view = render(<CookingAbilities familyId="f1" />);
	expect(await view.findByText(/Nobody has recorded these yet/)).toBeDefined();
	for (const name of ["Stove", "Oven", "Microwave", "Toaster", "Sharp knife"])
		expect(select(view, name).value).toBe("with_helper");

	fireEvent.change(select(view, "Stove"), { target: { value: "alone" } });
	fireEvent.change(select(view, "Sharp knife"), {
		target: { value: "not_allowed" },
	});
	fireEvent.change(
		view.getByRole("textbox", { name: "Foods they dislike (comma separated)" }),
		{ target: { value: ` liver , ,okra, ${"x".repeat(90)}` } },
	);
	fireEvent.click(view.getByRole("button", { name: "Save cooking abilities" }));

	expect(await view.findByText(/Last changed/)).toBeDefined();
	const put = calls.find((c) => c.method === "PUT");
	expect(put?.path).toBe(PATH);
	expect(put?.body).toEqual({
		tasks: {
			stove: "alone",
			oven: "with_helper",
			microwave: "with_helper",
			toaster: "with_helper",
			knife: "not_allowed",
		},
		dislikes: ["liver", "okra", "x".repeat(80)],
	});
	expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
	expect(select(view, "Stove").value).toBe("alone");
	expect(select(view, "Sharp knife").value).toBe("not_allowed");
});

test("a recorded profile shows its choices and dislikes; a refused save says why and keeps the edits", async () => {
	signIn();
	serve({
		[`GET ${PATH}`]: { json: recorded },
		[`PUT ${PATH}`]: {
			status: 403,
			json: { error: "forbidden", message: "Care access is needed." },
		},
	});
	const view = render(<CookingAbilities familyId="f1" />);
	expect(await view.findByText(/Last changed/)).toBeDefined();
	expect(select(view, "Oven").value).toBe("not_allowed");
	const dislikes = view.getByRole("textbox", {
		name: "Foods they dislike (comma separated)",
	}) as HTMLInputElement;
	expect(dislikes.value).toBe("liver, okra");

	fireEvent.change(select(view, "Oven"), { target: { value: "alone" } });
	fireEvent.click(view.getByRole("button", { name: "Save cooking abilities" }));
	expect(view.getByRole("status").textContent).toBe("Saving…");
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe(
			"Not saved. Care access is needed.",
		),
	);
	expect(select(view, "Oven").value).toBe("alone");
});

test("a save the server refuses as signed out asks to sign in", async () => {
	signIn();
	const calls = serve({
		[`GET ${PATH}`]: { json: recorded },
		[`PUT ${PATH}`]: {
			status: 401,
			json: { error: "unauthorized", message: "Session expired." },
		},
	});
	const view = render(<CookingAbilities familyId="f1" />);
	await view.findByText(/Last changed/);
	fireEvent.click(view.getByRole("button", { name: "Save cooking abilities" }));
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe("Sign in to save."),
	);
	expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
});

test("without care access, the profile is not shown", async () => {
	signIn();
	serve({
		[`GET ${PATH}`]: {
			status: 403,
			json: { error: "forbidden", message: "Care access is needed." },
		},
	});
	const view = render(<CookingAbilities familyId="f1" />);
	expect(await view.findByText("Not a member of this family")).toBeDefined();
	expect(
		view.queryByRole("button", { name: "Save cooking abilities" }),
	).toBeNull();
});

test("signed out, it asks to sign in instead of loading", async () => {
	const calls = serve({});
	const { view } = await renderRouted(<CookingAbilities familyId="f1" />);
	expect(
		await view.findByText("Sign in to see cooking abilities."),
	).toBeDefined();
	expect(calls).toHaveLength(0);
});
