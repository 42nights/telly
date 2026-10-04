import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

const records = (messages: object[]) => ({
	families: [FAMILY],
	samples: [],
	alerts: [],
	messages,
	acknowledgements: [],
});

const message = (over: object) => ({
	id: "m",
	familyId: "fam-1",
	sender: OTHER,
	body: "Hello",
	sentAt: "2026-10-01T08:00:00.000Z",
	clientId: "c",
	...over,
});

// The preview is one paragraph: "<b>sender</b>: body".
const preview = (text: string) => (_: string, el: Element | null) =>
	el?.tagName === "P" && el.textContent === text;

const chat = () =>
	screen.getByRole("region", { name: "Family chat" }) as HTMLElement;

test("shows the person's name and the newest message of this family in the chat preview", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: ME,
		},
		"GET /api/families/fam-1": records([
			message({
				id: "1",
				body: "Old news",
				sentAt: "2026-10-01T08:00:00.000Z",
			}),
			message({
				id: "2",
				body: "Lunch is ready",
				sender: ME,
				sentAt: "2026-10-01T12:00:00.000Z",
			}),
			message({ id: "3", body: "Older", sentAt: "2026-10-01T09:00:00.000Z" }),
			message({
				id: "4",
				familyId: "fam-2",
				body: "Other family",
				sentAt: "2026-10-02T00:00:00.000Z",
			}),
		]),
	});
	renderRoute("/family");

	expect(
		await screen.findByRole("heading", { name: "Grandma Rose", level: 2 }),
	).toBeTruthy();
	expect(screen.getByText("Family · Grandma Rose")).toBeTruthy();
	expect(
		await within(chat()).findByText(preview("You: Lunch is ready")),
	).toBeTruthy();
	expect(within(chat()).getByText("You")).toBeTruthy();
	expect(within(chat()).queryByText("Other family")).toBeNull();
	expect(
		within(chat())
			.getByRole("link", { name: "Open chat" })
			.getAttribute("href"),
	).toBe("/chat");
});

test("says there are no messages when the family has none", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1": records([]),
	});
	renderRoute("/family");
	expect(
		await within(
			await screen.findByRole("region", { name: "Family chat" }),
		).findByText("No messages yet."),
	).toBeTruthy();
});

test("shows a member label for a message from someone else", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1": records([message({ body: "Hi Mum" })]),
	});
	renderRoute("/family");
	expect(
		await screen.findByText(preview("Member bbbbbb: Hi Mum")),
	).toBeTruthy();
	expect(within(chat()).getByText("Member bbbbbb")).toBeTruthy();
});

test("tells a caller who is not a member of the family that the messages are forbidden", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1": json(403, {
			error: "forbidden",
			message: "You are not a member of this family.",
		}),
	});
	renderRoute("/family");
	const region = await screen.findByRole("region", { name: "Family chat" });
	expect(
		await within(region).findByText("Not a member of this family"),
	).toBeTruthy();
	expect(
		within(region).getByText("You are not a member of this family."),
	).toBeTruthy();
});

test("says no person is paired when the account has no family", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	renderRoute("/family");
	expect(
		await screen.findByText(
			"No person is paired with this account yet. People are paired manually.",
		),
	).toBeTruthy();
	expect(screen.getByText("Family · No person")).toBeTruthy();
});

test("reports an unavailable family list", async () => {
	signIn();
	serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "Database is down.",
		}),
	});
	renderRoute("/family");
	expect(await screen.findByText("Your family unavailable")).toBeTruthy();
	expect(screen.getByText("Database is down.")).toBeTruthy();
});
