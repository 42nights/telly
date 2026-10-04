import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { FamilyMessage, FamilyRecords } from "@health/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ApiState } from "@/lib/api";
import {
	act,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { Messages } from "./messages";

installDom();

/** `Link` needs a router: renders `ui` as the root route of an in-memory one. */
const inRouter = (ui: ReactNode) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory(),
	});
	return render(<RouterProvider router={router} />);
};

const me = "a".repeat(64);
const other = "b0c1d2".padEnd(64, "e");
const message = (over: Partial<FamilyMessage>): FamilyMessage => ({
	id: "m1",
	familyId: "1",
	sender: other,
	body: "Dinner at six",
	sentAt: "2026-01-01T08:00:00Z",
	clientId: "c1",
	...over,
});
const ready = (messages: FamilyMessage[]): ApiState<FamilyRecords> => ({
	kind: "ready",
	at: 0,
	value: {
		families: [],
		samples: [],
		alerts: [],
		messages,
		acknowledgements: [],
	},
});
const meRoute = {
	"GET /api/me": {
		json: {
			issuer: "i",
			subject: "s",
			identity: me,
			name: null,
			givenName: null,
			email: null,
			picture: null,
		},
	},
};

// happy-dom does not play sound: record what would play instead.
const played: string[] = [];
beforeEach(() => {
	played.length = 0;
	spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		played.push(this.src);
		return Promise.resolve();
	});
});
afterEach(() => {
	mock.restore();
});

describe("Messages", () => {
	test("a records failure shows its notice instead of messages", () => {
		serve(meRoute);
		const view = render(
			<Messages
				familyId="1"
				records={{ kind: "forbidden", message: "Not yours" }}
			/>,
		);
		const alert = view.getByRole("alert");
		expect(alert.textContent).toContain("Not a member of this family");
		expect(alert.textContent).toContain("Not yours");
		expect(view.queryByRole("list")).toBeNull();
	});

	test("shows this family's messages newest first, with who wrote each, and no alert notices", async () => {
		serve(meRoute);
		const view = inRouter(
			<Messages
				familyId="1"
				records={ready([
					message({
						id: "old",
						body: "Old news",
						sentAt: "2026-01-01T07:00:00Z",
					}),
					message({
						id: "mine",
						sender: me,
						body: "On my way",
						sentAt: "2026-01-01T09:00:00Z",
					}),
					message({
						id: "alert",
						clientId: "alert-7",
						body: "Heart rate high",
					}),
					message({ id: "elsewhere", familyId: "2", body: "Other family" }),
				])}
			/>,
		);
		const chat = await view.findByRole("link", { name: "Open family chat" });
		expect(chat.getAttribute("href")).toBe("/chat");
		await waitFor(() =>
			expect(view.getAllByRole("listitem")[0]?.textContent).toContain("You"),
		);
		const items = view.getAllByRole("listitem");
		// The alert notice is not repeated here: Alerts on Home shows it once (captain: "2 alerts?").
		expect(
			items.map((item) => item.querySelector("p + p")?.textContent),
		).toEqual(["On my way", "Old news"]);
		expect(view.queryByText("Telly alert")).toBeNull();
		expect(items[1]?.textContent).toContain("Member b0c1d2");
		expect(items[0]?.querySelector("time")?.getAttribute("dateTime")).toBe(
			"2026-01-01T09:00:00Z",
		);
	});

	test("before the caller is known, their own message shows a member label", async () => {
		serve({ "GET /api/me": { status: 401 } });
		const view = inRouter(
			<Messages familyId="1" records={ready([message({ sender: me })])} />,
		);
		const item = await view.findByRole("listitem");
		expect(item.textContent).toContain("Member aaaaaa");
	});

	test("with no messages it says so", async () => {
		serve(meRoute);
		const view = inRouter(<Messages familyId="1" records={ready([])} />);
		expect((await view.findByRole("listitem")).textContent).toBe(
			"No messages yet.",
		);
	});

	test("Listen reads that message aloud and then offers to say it again", async () => {
		const speech = Promise.withResolvers<ServerReply>();
		const calls = serve({
			...meRoute,
			"POST /api/families/1/voice/speech": () => speech.promise,
		});
		spyOn(URL, "createObjectURL").mockReturnValue("blob:speech");
		const view = inRouter(
			<Messages
				familyId="1"
				records={ready([
					message({ id: "a", body: "First" }),
					message({ id: "b", body: "Second", sentAt: "2026-01-01T07:00:00Z" }),
				])}
			/>,
		);
		const [first, second] = await view.findAllByRole("listitem");
		if (first === undefined || second === undefined) throw new Error("items");
		await act(async () =>
			within(first).getByRole("button", { name: "Listen" }).click(),
		);
		const button = within(first).getByRole("button", { name: "Say it again" });
		expect(button.hasAttribute("disabled")).toBe(true);
		expect(within(first).getByRole("status").textContent).toBe(
			"Getting the voice…",
		);
		expect(within(second).queryByRole("status")).toBeNull();
		expect(calls.at(-1)).toEqual({
			method: "POST",
			path: "/api/families/1/voice/speech",
			body: { text: "First" },
		});
		await act(async () => speech.resolve({ json: {} }));
		await waitFor(() =>
			expect(within(first).getByRole("status").textContent).toBe("Speaking…"),
		);
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(played).toEqual(["blob:speech"]);
		expect(
			within(second).getByRole("button", { name: "Listen" }),
		).toBeDefined();
	});

	test("a voice failure shows on that message", async () => {
		serve({
			...meRoute,
			"POST /api/families/1/voice/speech": {
				status: 503,
				body: { error: "unavailable", message: "No voice" },
			},
		});
		const view = inRouter(
			<Messages familyId="1" records={ready([message({})])} />,
		);
		const item = await view.findByRole("listitem");
		await act(async () =>
			within(item).getByRole("button", { name: "Listen" }).click(),
		);
		await waitFor(() =>
			expect(within(item).getByRole("alert").textContent).toBe(
				"The voice is not available right now.",
			),
		);
	});
});
