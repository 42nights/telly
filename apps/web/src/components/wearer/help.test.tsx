import "../test/setup";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import * as contacts from "@/lib/contacts";
import { fireEvent, installDom, render } from "../test/dom";

import { HelpPanel, SupportActions } from "./help";

installDom();
const dialed = spyOn(contacts, "dial").mockImplementation(() => {});
afterEach(() => {
	dialed.mockClear();
	localStorage.clear();
});

/** `Link` needs a router: renders `ui` as the root route of an in-memory one. */
const inRouter = (ui: ReactNode) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory(),
	});
	return render(<RouterProvider router={router} />);
};

const saveContacts = (contacts: object) =>
	localStorage.setItem("telly.contacts", JSON.stringify(contacts));

describe("SupportActions", () => {
	test("with a saved family number, Call family dials it in the phone's dialer", async () => {
		saveContacts({ familyPhone: "+1 (555) 010-2030" });
		const view = inRouter(<SupportActions familyId={null} onHelp={() => {}} />);
		const call = await view.findByRole("link", { name: "Call family" });
		expect(call.getAttribute("href")).toBe("tel:+15550102030");
	});

	test("without a number, Call family asks for it: Save & Call keeps it and opens the dialer", async () => {
		const view = inRouter(<SupportActions familyId={null} onHelp={() => {}} />);
		expect(view.container.textContent).not.toContain("Settings");
		fireEvent.click(await view.findByRole("button", { name: "Call family" }));
		const field = view.getByLabelText("Family phone number");
		fireEvent.change(field, { target: { value: "5550" } });
		fireEvent.click(view.getByRole("button", { name: "Save & Call" }));
		view.getByText("Enter the full phone number, with the area code.");
		expect(dialed).not.toHaveBeenCalled();

		fireEvent.change(field, { target: { value: "+1 555 010 0400" } });
		fireEvent.click(view.getByRole("button", { name: "Save & Call" }));
		expect(dialed.mock.calls).toEqual([["+1 555 010 0400"]]);
		// The next tap calls the saved number at once.
		expect(
			(await view.findByRole("link", { name: "Call family" })).getAttribute(
				"href",
			),
		).toBe("tel:+15550100400");
	});

	test("I need help now opens the help panel", async () => {
		const onHelp = mock(() => {});
		const view = inRouter(<SupportActions familyId={null} onHelp={onHelp} />);
		fireEvent.click(
			await view.findByRole("button", { name: "I need help now" }),
		);
		expect(onHelp).toHaveBeenCalledTimes(1);
	});
});

describe("HelpPanel", () => {
	test("puts the emergency number first, then family, and never claims a call was made", async () => {
		saveContacts({ familyPhone: "555-010-2030", emergency: "112" });
		const view = inRouter(
			<HelpPanel asked="I fell" familyId={null} onDone={() => {}} />,
		);
		await view.findByRole("link", { name: "Call family" });
		const links = view.getAllByRole("link");
		expect(
			links.map((link) => [
				link.textContent?.trim(),
				link.getAttribute("href"),
			]),
		).toEqual([
			["Call 112", "tel:112"],
			["Call family", "tel:5550102030"],
		]);
		expect(view.getByRole("alert").textContent).toContain(
			"This sounds urgent.",
		);
		expect(view.container.textContent).toContain("“I fell”");
		expect(view.container.textContent).toContain(
			"This app does not call anyone by itself.",
		);
	});

	test("without a saved number it calls 911 and shows no question when none was asked", async () => {
		const view = inRouter(
			<HelpPanel asked={null} familyId={null} onDone={() => {}} />,
		);
		const call = await view.findByRole("link", { name: "Call 911" });
		expect(call.getAttribute("href")).toBe("tel:911");
		expect(view.container.textContent).not.toContain("You asked");
	});

	test("Not urgent? Go back closes the panel", async () => {
		const onDone = mock(() => {});
		const view = inRouter(
			<HelpPanel asked={null} familyId={null} onDone={onDone} />,
		);
		fireEvent.click(
			await view.findByRole("button", { name: "Not urgent? Go back" }),
		);
		expect(onDone).toHaveBeenCalledTimes(1);
	});
});
