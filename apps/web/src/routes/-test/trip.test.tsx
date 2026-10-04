import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: Bun runs static imports before `dom` registers `document` and mocks `@/env`.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ME = "a".repeat(64);
const MOM = "b".repeat(64);
const NOW = new Date().toISOString();
const ME_REPLY = {
	issuer: "https://issuer.test",
	subject: "user-1",
	identity: ME,
};
const SHARE = { familyId: "1", sharer: ME, viewer: MOM, sharedAt: NOW };
const MY_LOCATION = {
	familyId: "1",
	sharer: ME,
	status: "fix",
	fix: { latitude: 1, longitude: 2, accuracyMeters: 5, fixTime: NOW },
	reportedAt: NOW,
};
const TRIP = {
	destination: "the pharmacy",
	purpose: "pick up pills",
	setAt: 1,
};

const base = (extra: Record<string, unknown> = {}) => ({
	"GET /api/families": { families: [FAMILY] },
	"GET /api/me": ME_REPLY,
	"GET /api/families/fam-1/location": { locations: [], shares: [] },
	...extra,
});

const attempt = {
	step: 1,
	member: MOM,
	name: "Mom",
	backup: false,
	channel: "message",
	status: "sent",
	body: "help",
	createdAt: NOW,
	updatedAt: NOW,
	contactLocalTime: "Sat 3:04 AM",
};
const need = (attempts: unknown[]) => ({
	id: "5",
	familyId: "1",
	kind: "help",
	summary: "s",
	facts: [],
	alertId: null,
	dueAt: NOW,
	status: "open",
	acceptedBy: null,
	followUpBy: null,
	raisedBy: ME,
	clientId: "c",
	createdAt: NOW,
	updatedAt: NOW,
	attempts,
	remaining: [],
});

// happy-dom has no geolocation; the reporter watches this fake instead.
type Watcher = { ok: PositionCallback; fail: PositionErrorCallback | null };
let watcher: Watcher | null = null;
let cleared = 0;
const geolocation = {
	watchPosition: (
		ok: PositionCallback,
		fail?: PositionErrorCallback | null,
	) => {
		watcher = { ok, fail: fail ?? null };
		return 7;
	},
	clearWatch: () => {
		cleared++;
	},
};
Object.defineProperty(navigator, "geolocation", {
	value: geolocation,
	configurable: true,
});
afterEach(() => {
	watcher = null;
});

test("plans a trip: blank destination stays disabled, the trimmed plan is saved", async () => {
	signIn();
	serve(base());
	renderRoute("/trip");
	const start = await screen.findByRole("button", { name: "Start trip" });
	expect(start.hasAttribute("disabled")).toBe(true);
	const where = screen.getByLabelText("Where are you going?");
	fireEvent.change(where, { target: { value: "   " } });
	fireEvent.submit(screen.getByRole("form", { name: "Plan a trip" }));
	expect(localStorage.getItem("telly.trip")).toBeNull();
	expect(screen.queryByText("Keep the old plan")).toBeNull();

	fireEvent.change(where, { target: { value: "  the park " } });
	fireEvent.change(screen.getByLabelText(/What for\?/), {
		target: { value: " " },
	});
	fireEvent.submit(screen.getByRole("form", { name: "Plan a trip" }));
	expect(
		await screen.findByRole("heading", { name: "You are going to the park" }),
	).toBeTruthy();
	expect(screen.queryByText(/^To /)).toBeNull();
	const saved = JSON.parse(localStorage.getItem("telly.trip") ?? "null");
	expect(saved).toMatchObject({ destination: "the park", purpose: "" });
	expect(
		screen.getByRole("link", { name: "Directions" }).getAttribute("href"),
	).toContain("destination=the%20park");
});

test("changes plans, keeps the old plan, and cancels the trip", async () => {
	signIn();
	localStorage.setItem("telly.trip", JSON.stringify(TRIP));
	serve(base());
	renderRoute("/trip");
	expect(await screen.findByText("To pick up pills.")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "My plans changed" }));
	expect(
		(screen.getByLabelText("Where are you going?") as HTMLInputElement).value,
	).toBe("the pharmacy");
	fireEvent.click(screen.getByRole("button", { name: "Keep the old plan" }));
	expect(
		screen.getByRole("heading", { name: "You are going to the pharmacy" }),
	).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "My plans changed" }));
	fireEvent.change(screen.getByLabelText("Where are you going?"), {
		target: { value: "the bank" },
	});
	fireEvent.submit(screen.getByRole("form", { name: "Plan a trip" }));
	expect(
		await screen.findByRole("heading", { name: "You are going to the bank" }),
	).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Cancel trip" }));
	expect(
		await screen.findByRole("button", { name: "Start trip" }),
	).toBeTruthy();
	expect(localStorage.getItem("telly.trip")).toBeNull();
});

test("Remind me asks the voice for the plan and shows a voice failure", async () => {
	signIn();
	localStorage.setItem("telly.trip", JSON.stringify(TRIP));
	const calls = serve(
		base({
			"POST /api/families/fam-1/voice/speech": json(503, {
				error: "unavailable",
				message: "down",
			}),
		}),
	);
	renderRoute("/trip");
	fireEvent.click(await screen.findByRole("button", { name: "Remind me" }));
	expect(
		await screen.findByText("The voice is not available right now."),
	).toBeTruthy();
	const sent = calls.find((c) => c.path.endsWith("/voice/speech"));
	expect(sent?.body).toMatchObject({
		text: expect.stringContaining(
			"You are going to the pharmacy, to pick up pills.",
		),
	});
});

test("help: sends one need, names the contact, and offers Mom and home links", async () => {
	signIn();
	localStorage.setItem("telly.trip", JSON.stringify(TRIP));
	localStorage.setItem(
		"telly.contacts",
		JSON.stringify({ momPhone: "+15551234567" }),
	);
	localStorage.setItem("telly.home", "12 Oak St");
	const calls = serve(
		base({
			"POST /api/families/fam-1/care/needs": need([attempt]),
			"POST /api/families/fam-1/voice/speech": json(503, {
				error: "unavailable",
				message: "x",
			}),
		}),
	);
	renderRoute("/trip");
	expect(
		(await screen.findByRole("link", { name: "Call Mom" })).getAttribute(
			"href",
		),
	).toContain("tel:");
	expect(
		screen.getByRole("link", { name: "Directions home" }).getAttribute("href"),
	).toContain("destination=12%20Oak%20St");

	fireEvent.click(
		screen.getByRole("button", { name: "Tell my family I need help" }),
	);
	expect(
		await screen.findByText(/I asked Mom\. Telly keeps asking your family/),
	).toBeTruthy();
	const post = calls.find((c) => c.path.endsWith("/care/needs"));
	expect(post?.method).toBe("POST");
	expect(post?.body).toMatchObject({
		kind: "help",
		sampleIds: [],
		dueAt: null,
		summary: expect.stringContaining(
			"I was going to the pharmacy to pick up pills.",
		),
	});
	// The spoken answer reuses the help key.
	expect(
		await screen.findByText("The voice is not available right now."),
	).toBeTruthy();

	fireEvent.change(screen.getByLabelText(/Home address/), {
		target: { value: " " },
	});
	expect(localStorage.getItem("telly.home")).toBe(" ");
	expect(screen.queryByRole("link", { name: "Directions home" })).toBeNull();
});

test("help with nobody to contact says to call instead", async () => {
	signIn();
	serve(base({ "POST /api/families/fam-1/care/needs": need([]) }));
	renderRoute("/trip");
	expect(
		await screen.findByText("Add Mom's number in Settings to call her here."),
	).toBeTruthy();
	fireEvent.click(
		await screen.findByRole("button", { name: "Tell my family I need help" }),
	);
	expect(
		await screen.findByText(/Nobody is set up to be contacted yet/),
	).toBeTruthy();
});

test("help failure keeps the same client id for the retry", async () => {
	signIn();
	let fail = true;
	const calls = serve(
		base({
			"POST /api/families/fam-1/care/needs": () =>
				fail
					? json(503, { error: "unavailable", message: "Server busy." })
					: need([attempt]),
		}),
	);
	renderRoute("/trip");
	fireEvent.click(
		await screen.findByRole("button", { name: "Tell my family I need help" }),
	);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Not sent: Server busy. Call instead.",
	);
	fail = false;
	fireEvent.click(
		screen.getByRole("button", { name: "Try again: tell my family" }),
	);
	expect(await screen.findByText(/I asked Mom/)).toBeTruthy();
	const ids = calls
		.filter((c) => c.path.endsWith("/care/needs"))
		.map((c) => JSON.stringify(c.body).match(/"clientId":"([^"]+)"/)?.[1]);
	expect(ids).toHaveLength(2);
	expect(ids[0]).toBeString();
	expect(ids[0]).toBe(ids[1] ?? "");
});

test("help while the session expires asks to sign in again", async () => {
	signIn();
	serve(
		base({
			"POST /api/families/fam-1/care/needs": json(401, {
				error: "unauthorized",
				message: "no",
			}),
		}),
	);
	renderRoute("/trip");
	fireEvent.click(
		await screen.findByRole("button", { name: "Tell my family I need help" }),
	);
	expect(
		await screen.findByText("Not sent. Sign in again, or call instead."),
	).toBeTruthy();
});

test("help with no family set up fails without a request", async () => {
	signIn();
	const calls = serve(base({ "GET /api/families": { families: [] } }));
	renderRoute("/trip");
	fireEvent.click(
		await screen.findByRole("button", { name: "Tell my family I need help" }),
	);
	expect(
		await screen.findByText("No family is set up on this device."),
	).toBeTruthy();
	expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("signed out: location and help show sign-in notices, no fetch", async () => {
	const calls = serve({});
	renderRoute("/trip");
	expect(
		await screen.findByRole("heading", { name: "My location" }),
	).toBeTruthy();
	await waitFor(() =>
		expect(screen.getAllByText(/sign in/i).length).toBeGreaterThan(0),
	);
	expect(calls).toEqual([]);
});

test("location forbidden, unavailable, and unreachable show notices", async () => {
	for (const reply of [
		json(403, { error: "forbidden", message: "Not yours." }),
		json(503, { error: "unavailable", message: "Down." }),
		() => {
			throw new TypeError("Failed to fetch");
		},
	]) {
		signIn();
		serve(base({ "GET /api/families/fam-1/location": reply }));
		const { unmount } = renderRoute("/trip");
		const section = (
			await screen.findByRole("heading", { name: "My location" })
		).parentElement;
		await waitFor(() => expect(section?.textContent).not.toMatch(/Loading/i));
		expect(section?.textContent).not.toContain("Who can see my location");
		unmount();
	}
});

test("me failing shows the sharing-settings notice", async () => {
	signIn();
	serve(
		base({
			"GET /api/me": json(503, { error: "unavailable", message: "Me down." }),
		}),
	);
	renderRoute("/trip");
	const section = (await screen.findByRole("heading", { name: "My location" }))
		.parentElement;
	await waitFor(() => expect(section?.textContent).toContain("Me down."));
});

test("not sharing: explains that nothing is sent", async () => {
	signIn();
	serve(base());
	renderRoute("/trip");
	expect(
		await screen.findByText(
			"Not shared. Telly sends your location only to people you choose.",
		),
	).toBeTruthy();
	expect(screen.getByText(/Nobody\. Telly sends no location/)).toBeTruthy();
});

test("sharing without a trip asks to start one and shows the last report", async () => {
	signIn();
	serve(
		base({
			"GET /api/families/fam-1/location": {
				locations: [MY_LOCATION],
				shares: [SHARE],
			},
		}),
	);
	renderRoute("/trip");
	expect(
		await screen.findByText(
			"Shared during a trip. Start a trip to send your location.",
		),
	).toBeTruthy();
	expect(
		screen.getByRole("heading", { name: "What your family sees" }),
	).toBeTruthy();
});

test("sharing during a trip sends the position and shows when it was sent", async () => {
	signIn();
	localStorage.setItem("telly.trip", JSON.stringify(TRIP));
	const calls = serve(
		base({
			"GET /api/families/fam-1/location": { locations: [], shares: [SHARE] },
			"POST /api/families/fam-1/location": MY_LOCATION,
		}),
	);
	const { unmount } = renderRoute("/trip");
	expect(await screen.findByText("Looking for your position…")).toBeTruthy();
	expect(
		screen.queryByRole("heading", { name: "What your family sees" }),
	).toBeNull();
	await waitFor(() => expect(watcher).not.toBeNull());
	watcher?.ok({
		coords: { latitude: 1, longitude: 2, accuracy: 5 },
		timestamp: Date.parse(NOW),
	} as GeolocationPosition);
	expect(
		await screen.findByText(/^Sent to the people you chose at /),
	).toBeTruthy();
	expect(
		screen.getByRole("heading", { name: "What your family sees" }),
	).toBeTruthy();
	const post = calls.find((c) => c.method === "POST");
	expect(post?.body).toMatchObject({
		status: "fix",
		fix: { latitude: 1, longitude: 2 },
	});
	unmount();
	expect(cleared).toBeGreaterThan(0);
});

test("a refused position report shows an alert", async () => {
	signIn();
	localStorage.setItem("telly.trip", JSON.stringify(TRIP));
	const calls = serve(
		base({
			"GET /api/families/fam-1/location": { locations: [], shares: [SHARE] },
			"POST /api/families/fam-1/location": json(403, {
				error: "forbidden",
				message: "Share first.",
			}),
		}),
	);
	renderRoute("/trip");
	await waitFor(() => expect(watcher).not.toBeNull());
	watcher?.fail?.({
		code: 1,
		PERMISSION_DENIED: 1,
	} as GeolocationPositionError);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Not sent: Share first.",
	);
	expect(calls.find((c) => c.method === "POST")?.body).toEqual({
		status: "gps_denied",
	});
});

test("stopping a share reloads the locations", async () => {
	signIn();
	let stopped = false;
	const calls = serve(
		base({
			"GET /api/families/fam-1/location": () =>
				stopped
					? { locations: [], shares: [] }
					: { locations: [], shares: [SHARE] },
			[`DELETE /api/families/fam-1/location/shares/${MOM}`]: () => {
				stopped = true;
				return { locations: [], shares: [] };
			},
		}),
	);
	renderRoute("/trip");
	await screen.findByText(
		"Shared during a trip. Start a trip to send your location.",
	);
	const before = calls.filter((c) => c.path.endsWith("/location")).length;
	fireEvent.click(screen.getByRole("button", { name: /^Stop sharing with/ }));
	expect(
		await screen.findByText(
			"Not shared. Telly sends your location only to people you choose.",
		),
	).toBeTruthy();
	expect(
		calls.filter((c) => c.path.endsWith("/location")).length,
	).toBeGreaterThan(before);
});
