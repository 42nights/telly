import "../test/setup";

import { describe, expect, test } from "bun:test";
import { FamilyProvider } from "@/lib/family";
import {
	fireEvent,
	installDom,
	type Reply,
	render,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { SettingsForm } from "./settings-form";

installDom();

const ROSE: Reply = {
	json: {
		families: [
			{ id: "7", name: "rose", createdAt: "2026-01-01T00:00:00.000Z" },
		],
	},
};
const INVALID = "Enter a full phone number, like (555) 010-0123";

const show = (families: Reply | (() => Promise<Reply>) = ROSE) => {
	serve({ "GET /api/families": families });
	const view = render(
		<FamilyProvider>
			<SettingsForm />
		</FamilyProvider>,
	);
	// The form remounts when the saved numbers change, so query it fresh each time.
	const text = () =>
		view.getByRole("region", { name: "Settings · Phone numbers" }).textContent;
	const field = (name: string) =>
		view.getByRole("textbox", { name }) as HTMLInputElement;
	const save = () => view.getByRole("button", { name: "Save" });
	return { view, text, field, save };
};

const stored = () =>
	JSON.parse(localStorage.getItem("telly.contacts") ?? "null");

describe("SettingsForm", () => {
	test("starts with the call buttons off and 911 for emergencies", async () => {
		const { view, text, field, save } = show();
		const person = view.getByRole("group", { name: "Person" });
		await within(person).findByText("rose");
		expect(within(person).getByText("R")).toBeDefined();
		expect(field("Mom's phone number").value).toBe("");
		expect(field("Mom's phone number").getAttribute("aria-describedby")).toBe(
			"settings-mom-note",
		);
		expect(text()).toContain("Call Mom stays off until you add a number.");
		expect(text()).toContain("Call family stays off until you add a number.");
		expect(field("Emergency number").value).toBe("911");
		expect(
			field("Emergency number").getAttribute("aria-describedby") === null,
		).toBe(true);
		expect(text()).toContain("Nothing to save yet");
		expect(save()).toHaveProperty("disabled", true);
	});

	test("rejects a number that is not dialable and does not save it", () => {
		const { view, text, field, save } = show();
		fireEvent.change(field("Mom's phone number"), {
			target: { value: "555-01ab" },
		});
		expect(field("Mom's phone number").getAttribute("aria-invalid")).toBe(
			"true",
		);
		expect(field("Mom's phone number").getAttribute("aria-describedby")).toBe(
			"settings-mom-error",
		);
		expect(text()).toContain(INVALID);
		expect(text()).toContain("Not saved");
		expect(save()).toHaveProperty("disabled", true);
		fireEvent.submit(view.getByRole("form", { name: "Phone numbers" }));
		expect(stored()).toBeNull();
	});

	test("an emergency number cannot be blank", () => {
		const { text, field, save } = show();
		fireEvent.change(field("Emergency number"), { target: { value: "  " } });
		expect(text()).toContain(INVALID);
		expect(save()).toHaveProperty("disabled", true);
	});

	test("saves trimmed numbers on this device and shows when", async () => {
		const { text, field, save } = show();
		fireEvent.change(field("Mom's phone number"), {
			target: { value: " (555) 010-0123 " },
		});
		fireEvent.change(field("Family phone number"), {
			target: { value: "+44 20 7946 0958" },
		});
		fireEvent.change(field("Emergency number"), { target: { value: "112" } });
		expect(text()).toContain("Changes not saved");
		expect(save()).toHaveProperty("disabled", false);
		fireEvent.click(save());
		expect(stored()).toMatchObject({
			momPhone: "(555) 010-0123",
			familyPhone: "+44 20 7946 0958",
			emergency: "112",
		});
		await waitFor(() => expect(text()).toContain("Saved on this device · "));
		expect(field("Mom's phone number").value).toBe("(555) 010-0123");
		expect(save()).toHaveProperty("disabled", true);
	});

	test("clearing a saved number turns its call button off", async () => {
		localStorage.setItem(
			"telly.contacts",
			JSON.stringify({
				momPhone: "555-010-0123",
				familyPhone: "555-010-0456",
				emergency: "999",
				savedAt: 1,
			}),
		);
		const { text, field, save } = show();
		await waitFor(() =>
			expect(field("Mom's phone number").value).toBe("555-010-0123"),
		);
		expect(field("Emergency number").value).toBe("999");
		fireEvent.change(field("Mom's phone number"), { target: { value: "" } });
		expect(text()).toContain("Call Mom stays off until you add a number.");
		fireEvent.click(save());
		expect(stored()).toMatchObject({
			momPhone: null,
			familyPhone: "555-010-0456",
			emergency: "999",
		});
	});

	test("says why there is no person", async () => {
		const loading = show(() => new Promise<Reply>(() => {}));
		expect(loading.view.getByText("Loading…")).toBeDefined();
		expect(loading.view.getByText("?")).toBeDefined();
		loading.view.unmount();

		const signedOut = show({ status: 401 });
		expect(
			await signedOut.view.findByText("Sign in to see the person"),
		).toBeDefined();
		signedOut.view.unmount();

		const none = show({ json: { families: [] } });
		expect(await none.view.findByText("No person yet")).toBeDefined();
		none.view.unmount();

		const failed = show({
			status: 500,
			body: { error: "internal", message: "Database down" },
		});
		expect(
			await failed.view.findByText("Not available: Database down"),
		).toBeDefined();
	});
});
