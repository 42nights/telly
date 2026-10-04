import "./test/setup";

import { expect, test } from "bun:test";
import { fireEvent, installDom, render, serve, waitFor } from "./test/dom";
import { TextTellyButton, tellyVCard } from "./text-telly";

installDom();

test("the contact card is a vCard named Telly with the line's number", () => {
	expect(tellyVCard("+14155951440")).toBe(
		"BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Telly;;;\r\nFN:Telly\r\nTEL;TYPE=CELL:+14155951440\r\nEND:VCARD\r\n",
	);
});

test("the dialog shows the number with Message Telly and Add to Contacts", async () => {
	serve({
		"GET /api/text-telly": {
			json: { tellyNumber: "+14155951440", myPhone: null },
		},
	});
	const view = render(<TextTellyButton />);
	fireEvent.click(view.getByRole("button", { name: "Text Telly" }));
	await waitFor(() => view.getByText("+1 (415) 595-1440"));
	view.getByText(/Save your phone number in Settings first/);
	expect(
		view.getByRole("link", { name: "Message Telly" }).getAttribute("href"),
	).toBe("sms:+14155951440?&body=Hi%20Telly");
	const card = view.getByRole("link", { name: "Add to Contacts" });
	expect(card.getAttribute("download")).toBe("Telly.vcf");
	expect(decodeURIComponent(card.getAttribute("href") ?? "")).toBe(
		`data:text/vcard;charset=utf-8,${tellyVCard("+14155951440")}`,
	);
});

test("without a Telly line the dialog says so", async () => {
	serve({
		"GET /api/text-telly": { json: { tellyNumber: null, myPhone: null } },
	});
	const view = render(<TextTellyButton />);
	await waitFor(() =>
		view.getByText("Texting Telly is not set up on this server."),
	);
	expect(view.queryByText("Message Telly")).toBeNull();
});
