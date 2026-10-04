import { expect, test } from "bun:test";
import { NewCareNeed } from "@health/contracts/care";
import { Schema } from "effect";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `setupDom()` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);
const { getSessionToken } = await import("@/lib/session");

const ME = "a".repeat(64);
const NEEDS = "/api/families/fam-1/care/needs";
const LADDER = "/api/families/fam-1/care/ladder";
const AT = "2026-10-04T10:00:00.000Z";

const need = (patch: object = {}) => ({
	id: "7",
	familyId: "1",
	kind: "help",
	summary: "Pick up groceries",
	facts: [],
	alertId: null,
	dueAt: AT,
	status: "open",
	acceptedBy: null,
	followUpBy: null,
	raisedBy: ME,
	clientId: "c-1",
	createdAt: AT,
	updatedAt: AT,
	attempts: [
		{
			step: 1,
			member: ME,
			name: "Ann",
			backup: false,
			channel: "message",
			status: "sent",
			body: "Help is needed",
			createdAt: AT,
			updatedAt: AT,
			contactLocalTime: "Sun 10:00 AM (UTC)",
		},
	],
	remaining: ["Bob"],
	...patch,
});

const ladder = (updatedAt: string) => ({
	contacts: [
		{
			member: ME,
			name: "Ann",
			timeZone: "UTC",
			detail: "summary",
			callFor: ["alert"],
		},
	],
	backup: null,
	answerSeconds: 120,
	followUpSeconds: 1800,
	updatedBy: ME,
	updatedAt,
});

const family = {
	"GET /api/families": { families: [FAMILY] },
	"GET /api/me": {
		issuer: "https://issuer.test",
		subject: "user-1",
		identity: ME,
	},
};

const gets = (calls: { method: string; path: string }[], path: string) =>
	calls.filter((call) => call.method === "GET" && call.path === path).length;

test("says so when no person is paired with the account", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });

	renderRoute("/care");

	expect(
		await screen.findByText("No person is paired with this account yet."),
	).toBeTruthy();
	expect(screen.queryByText("Care needs")).toBeNull();
});

test("shows an empty family with no needs and no ladder yet", async () => {
	signIn();
	serve({
		...family,
		[`GET ${NEEDS}`]: { needs: [] },
		[`GET ${LADDER}`]: { ladder: null },
	});

	renderRoute("/care");

	expect(
		await screen.findByRole("region", { name: "Care · Grandma Rose" }),
	).toBeTruthy();
	expect(await screen.findByText("No care needs.")).toBeTruthy();
	expect(
		await screen.findByText("No ladder yet: alerts contact nobody."),
	).toBeTruthy();
	expect(await screen.findByText(ME)).toBeTruthy();
});

test("shows why needs and the ladder could not load", async () => {
	signIn();
	serve({
		...family,
		[`GET ${NEEDS}`]: json(503, {
			error: "unavailable",
			message: "The care store is down.",
		}),
		[`GET ${LADDER}`]: { ladder: "not a ladder" },
	});

	renderRoute("/care");

	expect(await screen.findByText("Care needs unavailable")).toBeTruthy();
	expect(screen.getByText("The care store is down.")).toBeTruthy();
	expect(
		await screen.findByText("Could not load the contact ladder"),
	).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Save ladder" })).toBeNull();
});

test("accepting a need posts the answer, blocks repeats, and shows the new state", async () => {
	signIn();
	let needs = [need()];
	let reply = () => {};
	const calls = serve({
		...family,
		[`GET ${NEEDS}`]: () => ({ needs }),
		[`GET ${LADDER}`]: { ladder: null },
		[`POST ${NEEDS}/7/responses`]: async () => {
			await new Promise<void>((resolve) => {
				reply = resolve;
			});
			needs = [need({ status: "accepted", acceptedBy: ME, followUpBy: AT })];
			return need({ status: "accepted", acceptedBy: ME, followUpBy: AT });
		},
	});

	renderRoute("/care");

	const card = await screen.findByRole("article", {
		name: "Request for help: Waiting for someone to accept",
	});
	expect(within(card).getByText("Bob: not contacted yet")).toBeTruthy();
	expect(within(card).getByRole("button", { name: "Mark seen" })).toBeTruthy();
	expect(within(card).getByRole("button", { name: "I can't" })).toBeTruthy();
	fireEvent.click(within(card).getByRole("button", { name: "I'll take it" }));

	await waitFor(() =>
		expect(
			within(card)
				.getAllByRole("button")
				.every((button) => button.hasAttribute("disabled")),
		).toBe(true),
	);
	const sent = calls.find((call) => call.method === "POST");
	expect(sent?.path).toBe(`${NEEDS}/7/responses`);
	expect(sent?.body).toEqual({ response: "accept" });
	reply();

	const accepted = await screen.findByRole("article", {
		name: "Request for help: Accepted, help not confirmed yet",
	});
	expect(
		within(accepted).getByRole("button", { name: "Help confirmed" }),
	).toBeTruthy();
	expect(gets(calls, NEEDS)).toBe(2);
	expect(screen.queryByRole("alert")).toBeNull();
});

test("shows why an answer was not sent", async () => {
	signIn();
	let respond: () => unknown = () =>
		json(409, { error: "conflict", message: "Someone else took it." });
	serve({
		...family,
		[`GET ${NEEDS}`]: { needs: [need()] },
		[`GET ${LADDER}`]: { ladder: null },
		[`POST ${NEEDS}/7/responses`]: () => respond(),
	});

	renderRoute("/care");

	fireEvent.click(await screen.findByRole("button", { name: "I can't" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Not sent: Someone else took it.",
	);

	respond = () => {
		throw new TypeError("Failed to fetch");
	};
	fireEvent.click(screen.getByRole("button", { name: "Mark seen" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toMatch(
			/^Not sent: The server is not reachable/,
		),
	);

	// A 401 ends the session, so the screen asks the person to sign in again.
	respond = () => json(401, { error: "unauthorized", message: "Expired" });
	fireEvent.click(screen.getByRole("button", { name: "I'll take it" }));
	expect(await screen.findByText("Sign in to see your family.")).toBeTruthy();
	expect(getSessionToken()).toBeNull();
});

test("asking the family sends the need once per client id and clears the form", async () => {
	signIn();
	const replies: Array<() => Response | object> = [
		() => json(503, { error: "unavailable", message: "Try later." }),
		() => need({ kind: "call_reminder", summary: "Call Rose" }),
		() => json(401, { error: "unauthorized", message: "Expired" }),
	];
	const calls = serve({
		...family,
		[`GET ${NEEDS}`]: { needs: [] },
		[`GET ${LADDER}`]: { ladder: null },
		[`POST ${NEEDS}`]: () => replies.shift()?.() ?? {},
	});
	// Each body must be one the server accepts.
	const sent = () =>
		calls
			.filter((call) => call.method === "POST")
			.map((call) => Schema.decodeUnknownSync(NewCareNeed)(call.body));

	renderRoute("/care");

	const ask = await screen.findByRole("button", { name: "Ask" });
	expect(ask).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("Kind"), {
		target: { value: "call_reminder" },
	});
	fireEvent.change(screen.getByLabelText("What is needed"), {
		target: { value: "  Call Rose  " },
	});
	fireEvent.change(screen.getByLabelText("Not before (optional)"), {
		target: { value: "2026-10-05T09:30" },
	});
	expect(ask).toHaveProperty("disabled", false);

	fireEvent.click(ask);
	expect(await screen.findByText("Not sent: Try later.")).toBeTruthy();
	const [failed] = sent();
	expect(failed).toEqual({
		clientId: expect.any(String),
		kind: "call_reminder",
		summary: "Call Rose",
		sampleIds: [],
		dueAt: new Date("2026-10-05T09:30").toISOString(),
	});
	// The form keeps its text, so a resend is one click.
	expect(screen.getByLabelText("What is needed")).toHaveProperty(
		"value",
		"  Call Rose  ",
	);

	fireEvent.click(ask);
	expect(await screen.findByText("Sent to the first contact.")).toBeTruthy();
	expect(sent()[1]).toEqual(failed);
	expect(screen.getByLabelText("What is needed")).toHaveProperty("value", "");
	expect(screen.getByLabelText("Not before (optional)")).toHaveProperty(
		"value",
		"",
	);
	await waitFor(() => expect(gets(calls, NEEDS)).toBe(2));

	fireEvent.change(screen.getByLabelText("What is needed"), {
		target: { value: "Fetch the mail" },
	});
	fireEvent.click(ask);
	expect(await screen.findByText("Sign in to see your family.")).toBeTruthy();
	expect(getSessionToken()).toBeNull();
	const next = sent()[2];
	expect(next).toMatchObject({
		kind: "call_reminder",
		summary: "Fetch the mail",
		dueAt: null,
	});
	expect(next?.clientId).not.toBe(failed?.clientId);
});

test("saving the ladder reads it again", async () => {
	signIn();
	let saved = ladder("2026-10-01T00:00:00.000Z");
	const calls = serve({
		...family,
		[`GET ${NEEDS}`]: { needs: [] },
		[`GET ${LADDER}`]: () => ({ ladder: saved }),
		[`PUT ${LADDER}`]: () => {
			saved = ladder("2026-10-04T12:00:00.000Z");
			return { ladder: saved };
		},
	});

	renderRoute("/care");

	expect(await screen.findByDisplayValue("Ann")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Save ladder" }));

	await waitFor(() => expect(gets(calls, LADDER)).toBe(2));
	const put = calls.find((call) => call.method === "PUT");
	expect(put?.body).toEqual({
		contacts: saved.contacts,
		backup: null,
		answerSeconds: 120,
		followUpSeconds: 1800,
		updatedBy: ME,
		updatedAt: "2026-10-01T00:00:00.000Z",
	});
	expect(await screen.findByText("Saved")).toBeTruthy();
});
