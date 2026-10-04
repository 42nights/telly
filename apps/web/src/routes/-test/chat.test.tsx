import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const MESSAGES = "/api/families/fam-1/messages";

const message = {
	id: "1",
	familyId: "fam-1",
	sender: OTHER,
	body: "Lunch at noon?",
	sentAt: "2026-10-01T10:00:00.000Z",
	clientId: "c-1",
};

const answer = {
	answer: "Her pulse was 72 this morning.",
	evidence: [],
	alerts: [],
	unavailable: ["steps"],
	model: "gemini-2.5-flash",
	answeredAt: "2026-10-04T09:00:00.000Z",
	followUps: ["How did she sleep?"],
	urgent: false,
};

const family = (routes: Record<string, unknown>) =>
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: ME,
			name: null,
			givenName: null,
			email: null,
			picture: null,
		},
		...routes,
	});

const messageBox = () =>
	screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

// #245: a person without a family goes to onboarding instead of the chat.
test("a person without a family is sent to onboarding", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	const { router } = renderRoute("/chat");

	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
	expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("a person who is not a member sees the refusal instead of the composer", async () => {
	signIn();
	family({
		[`GET ${MESSAGES}`]: json(403, {
			error: "forbidden",
			message: "Not a member of fam-1.",
		}),
	});
	renderRoute("/chat");

	expect(await screen.findByText("Not a member of this family")).toBeTruthy();
	expect(screen.getByText("Not a member of fam-1.")).toBeTruthy();
	expect(
		screen.getByRole("region", { name: "Family chat · Grandma Rose" }),
	).toBeTruthy();
	expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("shows loading while the messages are on their way", async () => {
	signIn();
	// A reply that never comes.
	family({ [`GET ${MESSAGES}`]: () => Promise.withResolvers().promise });
	renderRoute("/chat");

	expect(await screen.findByText("Loading messages…")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});

test("an empty thread says so and asks Gemini by default", async () => {
	signIn();
	family({ [`GET ${MESSAGES}`]: { messages: [] } });
	renderRoute("/chat");

	expect(await screen.findByText("No family messages yet.")).toBeTruthy();
	expect(messageBox().placeholder).toBe(
		"Ask about Grandma Rose's health records…",
	);
	expect(screen.getByText("To: family agent · Gemini")).toBeTruthy();
	expect(
		screen.getByRole("button", {
			name: /^In this chat: the members of Grandma Rose and the family agent/,
		}),
	).toBeTruthy();
});

test("Reply targets the member, focuses the box, and sends only to the family", async () => {
	signIn();
	const calls = family({
		[`GET ${MESSAGES}`]: { messages: [message] },
		[`POST ${MESSAGES}`]: new Response(null, { status: 204 }),
	});
	renderRoute("/chat");

	fireEvent.click(
		await screen.findByRole("button", { name: "Reply to Member bbbbbb" }),
	);

	expect(screen.getByText("Reply to Member bbbbbb")).toBeTruthy();
	expect(screen.getByText("To: family, not Gemini")).toBeTruthy();
	expect(document.activeElement).toBe(messageBox());

	fireEvent.change(messageBox(), { target: { value: "Yes, see you" } });
	fireEvent.click(screen.getByRole("button", { name: "Send" }));

	await waitFor(() => expect(messageBox().value).toBe(""));
	const sent = calls.filter((call) => call.method === "POST");
	expect(sent).toHaveLength(1);
	expect(sent[0]?.path).toBe(MESSAGES);
	expect(sent[0]?.body).toMatchObject({ body: "Yes, see you" });
	expect(screen.queryByText("Reply to Member bbbbbb")).toBeNull();
	expect(calls.some((call) => call.path.endsWith("/ask"))).toBe(false);
	// The send refreshes the thread from the last id it has.
	await waitFor(() =>
		expect(calls.some((call) => call.path === `${MESSAGES}?after=1`)).toBe(
			true,
		),
	);
});

test("Gemini answers, the chip turns ready, and a follow-up refills the box for Gemini", async () => {
	signIn();
	const calls = family({
		[`GET ${MESSAGES}`]: { messages: [message] },
		"POST /api/families/fam-1/ask": answer,
	});
	renderRoute("/chat");

	fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), {
		target: { value: "How was her pulse?" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send" }));

	expect(await screen.findByText(answer.answer)).toBeTruthy();
	expect(screen.getByText("Gemini · ready")).toBeTruthy();
	const ask = calls.find((call) => call.path === "/api/families/fam-1/ask");
	expect(ask?.method).toBe("POST");
	expect(ask?.body).toMatchObject({ question: "How was her pulse?" });
	await waitFor(() => expect(messageBox().value).toBe(""));

	// Start a family reply, then pick the follow-up: the reply ends and the box asks Gemini again.
	fireEvent.click(
		screen.getByRole("button", { name: "Reply to Member bbbbbb" }),
	);
	expect(screen.getByText("To: family, not Gemini")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "How did she sleep?" }));

	expect(messageBox().value).toBe("How did she sleep?");
	expect(document.activeElement).toBe(messageBox());
	expect(screen.getByText("To: family agent · Gemini")).toBeTruthy();
	expect(screen.queryByText("Reply to Member bbbbbb")).toBeNull();
});

test("Gemini overloaded (503) marks the chip unavailable and explains why", async () => {
	signIn();
	family({
		[`GET ${MESSAGES}`]: { messages: [] },
		"POST /api/families/fam-1/ask": json(503, {
			error: "unavailable",
			message: "The model is overloaded.",
		}),
	});
	renderRoute("/chat");

	fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), {
		target: { value: "How was her pulse?" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send" }));

	expect(await screen.findByText("Gemini · unavailable")).toBeTruthy();
	expect(
		screen.getByRole("button", {
			name: "Gemini is unavailable: The model is overloaded.",
		}),
	).toBeTruthy();
	expect(screen.getByText("Not answered")).toBeTruthy();
	expect(screen.getByText("The model is overloaded.")).toBeTruthy();
	// The question stays in the box so it can be sent again.
	expect(messageBox().value).toBe("How was her pulse?");
});

test("an unavailable server shows the outage, blocks Send, and Try again reloads", async () => {
	signIn();
	let reads = 0;
	const calls = family({
		[`GET ${MESSAGES}`]: () =>
			++reads === 1
				? json(503, { error: "unavailable", message: "Database down." })
				: { messages: [message] },
	});
	renderRoute("/chat");

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("The server is not available.");
	expect(alert.textContent).toContain("Database down.");
	expect(screen.getByText("Messages could not be loaded.")).toBeTruthy();
	expect(
		(screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	expect(
		screen.getByRole("link", { name: "Contact support" }).getAttribute("href"),
	).toBe("mailto:vexzyl@pm.me?subject=Telly%20support");

	fireEvent.click(screen.getByRole("button", { name: "Try again" }));

	expect(await screen.findByText("Lunch at noon?")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
	expect(
		(screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
			.disabled,
	).toBe(false);
	expect(calls.filter((call) => call.path === MESSAGES)).toHaveLength(2);
});

test("an unreachable server says it is not reachable", async () => {
	signIn();
	family({
		[`GET ${MESSAGES}`]: () => {
			throw new TypeError("Failed to fetch");
		},
	});
	renderRoute("/chat");

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("The server is not reachable.");
	expect(alert.textContent).toContain("Failed to fetch");
});
