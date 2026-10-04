import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: Bun runs static imports before `dom` registers `document` and mocks `@/env`.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);
const { apiStart } = await import("@/lib/api");
// The failure notices show at once here, not after the window a starting API gets.
apiStart.windowMs = 0;

const ME = "a".repeat(64);
const MOM = "b".repeat(64);
const NOW = new Date().toISOString();
const ME_REPLY = {
	issuer: "https://issuer.test",
	subject: "user-1",
	identity: ME,
	name: null,
	givenName: null,
	email: null,
	picture: null,
};
const SHARE = { familyId: "1", sharer: ME, viewer: MOM, sharedAt: NOW };
const HOME = { latitude: 40, longitude: -73 };
const MY_LOCATION = {
	familyId: "1",
	sharer: ME,
	status: "fix",
	// About 1.2 km north of HOME, as the server reports in `distanceMeters`.
	fix: { latitude: 40.011, longitude: -73, accuracyMeters: 5, fixTime: NOW },
	reportedAt: NOW,
};
const LOCATIONS = { locations: [], shares: [], seesShared: true, events: [] };
const WATCH = {
	home: null,
	radiusMeters: 200,
	autoTrip: false,
	awaySince: null,
	distanceMeters: null,
	sharing: false,
};

const base = (extra: Record<string, unknown> = {}) => ({
	"GET /api/families": { families: [FAMILY] },
	"GET /api/me": ME_REPLY,
	"GET /api/families/fam-1/location": LOCATIONS,
	"GET /api/families/fam-1/location/home": WATCH,
	"GET /api/families/fam-1/members": {
		members: [
			{ identity: ME, name: "Ana" },
			{ identity: MOM, name: "Rosa Rivera" },
		],
	},
	"GET /api/families/fam-1/care-access": {
		mine: [],
		grants: [
			{
				identity: MOM,
				scope: "location",
				granted: true,
				changedBy: ME,
				changedAt: NOW,
			},
		],
		history: [],
	},
	...extra,
});
const momBox = async () => {
	const box = await screen.findByRole("checkbox", { name: "Rosa Rivera" });
	if (!(box instanceof HTMLInputElement)) throw new Error("not a checkbox");
	return box;
};

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

// happy-dom has no geolocation; the reporter and "This is home" use this fake instead.
type Watcher = { ok: PositionCallback; fail: PositionErrorCallback | null };
let watcher: Watcher | null = null;
let here: Partial<GeolocationCoordinates> = { ...HOME, accuracy: 15 };
const geolocation = {
	watchPosition: (
		ok: PositionCallback,
		fail?: PositionErrorCallback | null,
	) => {
		watcher = { ok, fail: fail ?? null };
		return 7;
	},
	clearWatch: () => {
		watcher = null;
	},
	getCurrentPosition: (ok: PositionCallback) =>
		ok({ coords: here, timestamp: Date.now() } as GeolocationPosition),
};
Object.defineProperty(navigator, "geolocation", {
	value: geolocation,
	configurable: true,
});
afterEach(() => {
	watcher = null;
	here = { ...HOME, accuracy: 15 };
});

test("no form: one tap on This is home saves this position, turns on automatic trips, and shares with the family", async () => {
	signIn();
	let watch: Record<string, unknown> = WATCH;
	let shared = false;
	const calls = serve(
		base({
			"GET /api/families/fam-1/location/home": () => watch,
			"PUT /api/families/fam-1/location/home": (call: { body: unknown }) => {
				watch = { ...WATCH, ...(call.body as object) };
				return watch;
			},
			"GET /api/families/fam-1/location": () => ({
				...LOCATIONS,
				shares: shared ? [SHARE] : [],
			}),
			[`PUT /api/families/fam-1/location/shares/${MOM}`]: () => {
				shared = true;
				watch = { ...watch, sharing: true };
				return { ...LOCATIONS, shares: [SHARE] };
			},
		}),
	);
	renderRoute("/trip");
	expect((await momBox()).checked).toBe(false);
	fireEvent.click(await screen.findByRole("button", { name: "This is home" }));
	expect(
		await screen.findByText(
			"You are at home. Telly tells the people you chose when you go out.",
		),
	).toBeTruthy();
	expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
		home: HOME,
		radiusMeters: 200,
		autoTrip: true,
	});
	// The first home turns sharing on for every family member, never for the wearer.
	expect(
		calls
			.filter((c) => c.path.includes("/location/shares/"))
			.map((c) => c.path),
	).toEqual([`/api/families/fam-1/location/shares/${MOM}`]);
	await waitFor(async () => expect((await momBox()).checked).toBe(true));
	// Sharing and automatic trips on: this device now sends its position.
	await waitFor(() => expect(watcher).not.toBeNull());
});

test("a position known only roughly is not saved as home", async () => {
	signIn();
	here = { ...HOME, accuracy: 900 };
	const calls = serve(base());
	renderRoute("/trip");
	fireEvent.click(await screen.findByRole("button", { name: "This is home" }));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"only within 900 m",
	);
	expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("out: shows the distance and time, sends the position, and I'm back home ends the trip", async () => {
	signIn();
	const awaySince = new Date(Date.now() - 10 * 60_000).toISOString();
	const calls = serve(
		base({
			"GET /api/families/fam-1/location/home": {
				...WATCH,
				home: HOME,
				autoTrip: true,
				sharing: true,
				awaySince,
				distanceMeters: 1223,
			},
			"GET /api/families/fam-1/location": {
				...LOCATIONS,
				locations: [MY_LOCATION],
				shares: [SHARE],
			},
			"POST /api/families/fam-1/location": MY_LOCATION,
			"POST /api/families/fam-1/location/away": { ...WATCH, sharing: true },
		}),
	);
	renderRoute("/trip");
	expect(
		await screen.findByRole("heading", { name: "You are out" }),
	).toBeTruthy();
	expect(screen.getByText("1.2 km from home · left 10 min ago")).toBeTruthy();
	expect(
		screen.getByRole("link", { name: "Directions home" }).getAttribute("href"),
	).toContain("destination=40%2C-73");
	await waitFor(() => expect(watcher).not.toBeNull());
	watcher?.ok({
		coords: { latitude: 40.011, longitude: -73, accuracy: 5 },
		timestamp: Date.parse(NOW),
	} as GeolocationPosition);
	await waitFor(() =>
		expect(
			calls.find((c) => c.method === "POST" && c.path.endsWith("/location"))
				?.body,
		).toMatchObject({ status: "fix", fix: { latitude: 40.011 } }),
	);
	fireEvent.click(screen.getByRole("button", { name: "I'm back home" }));
	await waitFor(() =>
		expect(calls.find((c) => c.path.endsWith("/away"))?.body).toEqual({
			away: false,
		}),
	);
});

test("without a share, nothing is sent even with automatic trips on", async () => {
	signIn();
	serve(
		base({
			"GET /api/families/fam-1/location/home": {
				...WATCH,
				home: HOME,
				autoTrip: true,
			},
		}),
	);
	renderRoute("/trip");
	expect(
		await screen.findByText(/^Share your location with someone below/),
	).toBeTruthy();
	expect(watcher).toBeNull();
	expect((await momBox()).checked).toBe(false);
});

test("a refused position report shows an alert", async () => {
	signIn();
	const calls = serve(
		base({
			"GET /api/families/fam-1/location/home": {
				...WATCH,
				home: HOME,
				autoTrip: true,
				sharing: true,
			},
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

test("help: sends one need, names the contact, and offers Mom and a typed home address", async () => {
	signIn();
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
		summary: expect.stringContaining("I need help getting home."),
	});
	// The spoken answer reuses the help key.
	expect(
		await screen.findByText("The voice is not available right now."),
	).toBeTruthy();
	localStorage.removeItem("telly.home");
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

test("help with no family loaded fails without a request", async () => {
	signIn();
	// An empty list now redirects to /welcome (#245); a failed list leaves no family on /trip.
	const calls = serve(
		base({
			"GET /api/families": json(503, {
				error: "unavailable",
				message: "Down.",
			}),
		}),
	);
	renderRoute("/trip");
	fireEvent.click(
		await screen.findByRole("button", { name: "Tell my family I need help" }),
	);
	expect(
		await screen.findByText("No family is set up on this device."),
	).toBeTruthy();
	expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("location forbidden, unavailable, and unreachable show notices, never a list", async () => {
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
		await waitFor(() =>
			expect(document.body.textContent).toMatch(/who sees where you are/i),
		);
		expect(screen.queryAllByRole("checkbox")).toEqual([]);
		unmount();
	}
});

test("me failing shows the notice instead of the list", async () => {
	signIn();
	serve(
		base({
			"GET /api/me": json(503, { error: "unavailable", message: "Me down." }),
		}),
	);
	renderRoute("/trip");
	await waitFor(() => expect(document.body.textContent).toContain("Me down."));
	expect(screen.queryAllByRole("checkbox")).toEqual([]);
});

test("unticking a person stops the share and reloads the locations and the trip settings", async () => {
	signIn();
	let stopped = false;
	const calls = serve(
		base({
			"GET /api/families/fam-1/location": () => ({
				...LOCATIONS,
				shares: stopped ? [] : [SHARE],
			}),
			[`DELETE /api/families/fam-1/location/shares/${MOM}`]: () => {
				stopped = true;
				return LOCATIONS;
			},
		}),
	);
	renderRoute("/trip");
	const box = await momBox();
	await waitFor(() => expect(box.checked).toBe(true));
	const before = (end: string) =>
		calls.filter((c) => c.method === "GET" && c.path.endsWith(end)).length;
	const [locations, home] = [before("/location"), before("/location/home")];
	fireEvent.click(box);
	await waitFor(async () => expect((await momBox()).checked).toBe(false));
	expect(before("/location")).toBeGreaterThan(locations);
	await waitFor(() => expect(before("/location/home")).toBeGreaterThan(home));
});
