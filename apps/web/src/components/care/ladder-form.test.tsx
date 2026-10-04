// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type { ContactLadder, LadderContact } from "@health/contracts/care";

import {
	fireEvent,
	render,
	serve,
	setupDom,
	signIn,
	within,
} from "../test/dom-routed";
import { LadderForm } from "./ladder-form";

setupDom();

const PATH = "/api/families/7/care/ladder";
const ME = "a".repeat(64);
const BOB = "b".repeat(64);
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const contact = (member: string, name: string): LadderContact => ({
	member,
	name,
	timeZone: "America/Chicago",
	detail: "facts",
	callFor: ["help"],
});

const saved: ContactLadder = {
	contacts: [contact(BOB, "Bob")],
	backup: contact(ME, "Ann"),
	answerSeconds: 60,
	followUpSeconds: 600,
	updatedBy: ME,
	updatedAt: "2026-10-04T03:00:00.000Z",
};

const noop = () => {};

test("a family without a ladder starts with me as the first contact", () => {
	const view = render(
		<LadderForm path={PATH} ladder={null} me={ME} onSaved={noop} />,
	);
	expect(view.getByRole("status").textContent).toBe(
		"No ladder yet: alerts contact nobody.",
	);
	// The member's own identity is in a tooltip, not on the page.
	expect(view.queryByText(ME)).toBeNull();
	expect(
		view.getByRole("button", { name: new RegExp(`Yours is ${ME}`) }),
	).toBeDefined();
	const first = within(view.getByRole("group", { name: "Contact 1" }));
	expect(
		(first.getByLabelText("Member identity") as HTMLInputElement).value,
	).toBe(ME);
	expect((first.getByLabelText("Time zone") as HTMLInputElement).value).toBe(
		ZONE,
	);
	expect(
		(first.getByLabelText("Health alert") as HTMLInputElement).checked,
	).toBe(true);
	expect(
		view.getByRole("button", { name: "Remove last" }).hasAttribute("disabled"),
	).toBe(true);
	expect(view.getByRole("button", { name: "Add backup" })).toBeDefined();
});

test("while my identity loads the form says so and leaves the member blank", () => {
	const view = render(
		<LadderForm path={PATH} ladder={null} me={null} onSaved={noop} />,
	);
	expect(view.getByRole("button", { name: /Yours is loading…/ })).toBeDefined();
	expect(
		(view.getByLabelText("Member identity") as HTMLInputElement).value,
	).toBe("");
});

test("an edited ladder is saved as typed, and the caller hears about it", async () => {
	signIn();
	const calls = serve({ [`PUT ${PATH}`]: { json: { ladder: null } } });
	let savedCount = 0;
	const view = render(
		<LadderForm
			path={PATH}
			ladder={null}
			me={ME}
			onSaved={() => {
				savedCount++;
			}}
		/>,
	);
	const first = within(view.getByRole("group", { name: "Contact 1" }));
	fireEvent.change(first.getByLabelText("Name"), { target: { value: "Ann" } });
	fireEvent.change(first.getByLabelText("Time zone"), {
		target: { value: "Asia/Kolkata" },
	});
	fireEvent.change(first.getByLabelText("Details they may see"), {
		target: { value: "minimal" },
	});
	fireEvent.click(first.getByLabelText("Health alert"));
	fireEvent.click(first.getByLabelText("Call reminder"));

	fireEvent.click(view.getByRole("button", { name: "Add contact" }));
	const second = within(view.getByRole("group", { name: "Contact 2" }));
	fireEvent.change(second.getByLabelText("Name"), { target: { value: "Bob" } });
	fireEvent.change(second.getByLabelText("Member identity"), {
		target: { value: `  ${BOB} ` },
	});
	expect(
		(second.getByLabelText("Member identity") as HTMLInputElement).value,
	).toBe(BOB);

	fireEvent.click(view.getByRole("button", { name: "Add backup" }));
	const backup = within(view.getByRole("group", { name: "Backup" }));
	fireEvent.change(backup.getByLabelText("Name"), { target: { value: "Cy" } });

	fireEvent.change(view.getByLabelText("Seconds to accept"), {
		target: { value: "90" },
	});
	fireEvent.change(view.getByLabelText("Seconds to confirm"), {
		target: { value: "3600" },
	});
	fireEvent.click(view.getByRole("button", { name: "Save ladder" }));
	expect(view.getByRole("status").textContent).toBe("Saving…");
	expect(await view.findByText("Saved")).toBeDefined();
	expect(savedCount).toBe(1);
	expect(calls).toEqual([
		{
			method: "PUT",
			path: PATH,
			body: {
				contacts: [
					{
						member: ME,
						name: "Ann",
						timeZone: "Asia/Kolkata",
						detail: "minimal",
						callFor: ["call_reminder"],
					},
					{
						member: BOB,
						name: "Bob",
						timeZone: ZONE,
						detail: "summary",
						callFor: ["alert"],
					},
				],
				backup: {
					member: "",
					name: "Cy",
					timeZone: ZONE,
					detail: "summary",
					callFor: ["alert"],
				},
				answerSeconds: 90,
				followUpSeconds: 3600,
			},
		},
	]);
});

test("the ladder holds one to five contacts, and the backup can be removed", () => {
	const view = render(
		<LadderForm path={PATH} ladder={saved} me={ME} onSaved={noop} />,
	);
	expect(view.getByRole("status").textContent).toBe("Saved");
	expect(
		(view.getByLabelText("Seconds to accept") as HTMLInputElement).value,
	).toBe("60");
	const add = view.getByRole("button", { name: "Add contact" });
	for (let i = 0; i < 4; i++) fireEvent.click(add);
	expect(view.getByRole("group", { name: "Contact 5" })).toBeDefined();
	expect(add.hasAttribute("disabled")).toBe(true);
	fireEvent.click(view.getByRole("button", { name: "Remove last" }));
	expect(view.queryByRole("group", { name: "Contact 5" })).toBeNull();
	expect(add.hasAttribute("disabled")).toBe(false);

	expect(
		(
			within(view.getByRole("group", { name: "Backup" })).getByLabelText(
				"Name",
			) as HTMLInputElement
		).value,
	).toBe("Ann");
	fireEvent.click(view.getByRole("button", { name: "Remove backup" }));
	expect(view.queryByRole("group", { name: "Backup" })).toBeNull();
	expect(view.getByRole("button", { name: "Add backup" })).toBeDefined();
});

test("a refused save shows the server's reason and does not report saved", async () => {
	signIn();
	serve({
		[`PUT ${PATH}`]: {
			status: 400,
			json: {
				error: "invalid_request",
				message: "Contacts must be family members",
			},
		},
	});
	let savedCount = 0;
	const view = render(
		<LadderForm
			path={PATH}
			ladder={saved}
			me={ME}
			onSaved={() => {
				savedCount++;
			}}
		/>,
	);
	fireEvent.click(view.getByRole("button", { name: "Save ladder" }));
	expect(
		await view.findByText("Not saved: Contacts must be family members"),
	).toBeDefined();
	expect(savedCount).toBe(0);
});

test("signed out, saving asks to sign in and sends nothing", async () => {
	const calls = serve({});
	const view = render(
		<LadderForm path={PATH} ladder={saved} me={ME} onSaved={noop} />,
	);
	fireEvent.submit(view.getByRole("button", { name: "Save ladder" }));
	expect(await view.findByText("Sign in to save the ladder.")).toBeDefined();
	expect(calls).toEqual([]);
});
