import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `setupDom()` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);
const { apiStart } = await import("@/lib/api");
// The failure notices show at once here, not after the window a starting API gets.
apiStart.windowMs = 0;

const ME = "a".repeat(64);
const AT = "2026-10-04T10:00:00.000Z";
const BASE = "/api/families/fam-1";

const access = (mine: string[]) => {
	const grant = {
		identity: ME,
		scope: "health_records",
		granted: true,
		changedBy: ME,
		changedAt: AT,
	};
	return { mine, grants: [grant], history: [grant] };
};

const record = (editedAt: string | null) => ({
	familyId: "fam-1",
	profile: {
		preferredName: "Rose",
		language: null,
		timeZone: null,
		accessibilityNeeds: null,
		diagnoses: null,
		allergies: null,
		dietaryRestrictions: null,
		fluidRestrictions: null,
		activityRestrictions: null,
		routines: null,
		contacts: null,
		familiarDestinations: null,
		devices: null,
		declinedPrompts: [],
	},
	editedBy: editedAt === null ? null : ME,
	editedAt,
	history: editedAt === null ? [] : [{ editedBy: ME, editedAt }],
});

const plan = (mine: string[], base = BASE) => ({
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
	[`GET ${base}/care-access`]: access(mine),
	[`GET ${base}/care-profile`]: record(null),
	[`GET ${base}/care-instructions`]: { instructions: [] },
	[`GET ${base}/care-profile/prompt`]: {
		lines: ["Your name is Rose.", "Medicines are unknown."],
	},
});

test("with no person paired, goes to onboarding and reads no care plan", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });

	// An empty family list goes to /welcome (#245) before any Care tab shows.
	const { router } = renderRoute("/care-profile");

	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
	expect(calls.some((call) => call.path.includes("care"))).toBe(false);
});

test("an editor sees every part, and a saved profile is read again", async () => {
	signIn();
	let saved = record(null);
	const calls = serve({
		...plan(["health_records", "care_plan_edit"]),
		[`GET ${BASE}/care-profile`]: () => saved,
		[`PUT ${BASE}/care-profile`]: () => {
			saved = record("2026-10-04T12:00:00.000Z");
			return new Response(null, { status: 204 });
		},
	});

	// `/care-profile` redirects to the Care › Care plan tab (#254).
	const view = renderRoute("/care-profile");

	const hears = await screen.findByRole("region", {
		name: "What the wearer hears",
	});
	expect(
		within(hears)
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual(["Your name is Rose.", "Medicines are unknown."]);
	expect(
		screen.getByText("No instructions saved. Medicines are unknown."),
	).toBeTruthy();
	expect(screen.getByRole("form", { name: "Add an instruction" })).toBeTruthy();
	expect(
		await screen.findByText("Not saved yet: every fact is unknown."),
	).toBeTruthy();

	fireEvent.change(screen.getByLabelText("Preferred name"), {
		target: { value: "Rosie" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

	expect(await screen.findByText(/^Saved by You on /)).toBeTruthy();
	const put = calls.find((call) => call.method === "PUT");
	expect(put?.path).toBe(`${BASE}/care-profile`);
	expect(put?.body).toMatchObject({ preferredName: "Rosie", language: null });
	// After a write every part is read again.
	for (const part of [
		"/care-access",
		"/care-profile",
		"/care-instructions",
		"/care-profile/prompt",
	])
		expect(
			calls.filter(
				(call) => call.method === "GET" && call.path === `${BASE}${part}`,
			).length,
		).toBe(2);
	// The re-read profile replaces the edited form.
	expect(screen.getByLabelText("Preferred name")).toHaveProperty(
		"value",
		"Rose",
	);
	view.unmount();

	// Sharing moved to its own Care › Sharing tab (#254).
	renderRoute("/care/sharing");
	expect(
		await screen.findByText("Your access: Health records, Edit the care plan"),
	).toBeTruthy();
});

test("a member who may only read sees the plan without edit controls", async () => {
	signIn();
	serve(plan(["health_records"]));

	renderRoute("/care/plan");

	expect(
		await screen.findByText(
			"Your access does not include editing the care plan.",
		),
	).toBeTruthy();
	expect(screen.getByLabelText("Preferred name")).toHaveProperty(
		"readOnly",
		true,
	);
	expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
	expect(screen.queryByRole("form", { name: "Add an instruction" })).toBeNull();
});

test("each part without a grant says which access is missing", async () => {
	signIn();
	const refused = json(403, { error: "forbidden", message: "No grant" });
	serve({
		...plan([]),
		[`GET ${BASE}/care-access`]: refused,
		[`GET ${BASE}/care-profile`]: refused,
		[`GET ${BASE}/care-instructions`]: refused,
		[`GET ${BASE}/care-profile/prompt`]: refused,
	});

	const carePlan = renderRoute("/care/plan");

	await waitFor(() =>
		expect(
			screen.getAllByRole("alert").map((alert) => alert.textContent),
		).toEqual([
			"No access to the wearer's prompt: No grant. Ask the person who manages sharing.",
			"No access to care instructions: No grant. Ask the person who manages sharing.",
			"No access to the care profile: No grant. Ask the person who manages sharing.",
		]),
	);
	carePlan.unmount();

	renderRoute("/care/sharing");
	await waitFor(() =>
		expect(
			screen.getAllByRole("alert").map((alert) => alert.textContent),
		).toEqual([
			"No access to sharing: No grant. Ask the person who manages sharing.",
		]),
	);
	expect(screen.queryByRole("region", { name: "Sharing" })).toBeNull();
});

test("other failures and slow parts show their own notice", async () => {
	signIn();
	serve({
		...plan([]),
		[`GET ${BASE}/care-access`]: { mine: "everything" },
		// Never answers.
		[`GET ${BASE}/care-profile`]: () => Promise.withResolvers().promise,
		[`GET ${BASE}/care-instructions`]: () => {
			throw new TypeError("Failed to fetch");
		},
		[`GET ${BASE}/care-profile/prompt`]: json(503, {
			error: "unavailable",
			message: "The prompt builder is down.",
		}),
	});

	const carePlan = renderRoute("/care/plan");

	expect(
		await screen.findByText("The wearer's prompt unavailable"),
	).toBeTruthy();
	expect(screen.getByText("The prompt builder is down.")).toBeTruthy();
	expect(
		await screen.findByText("Could not load care instructions"),
	).toBeTruthy();
	expect(
		screen.getByText(
			/^The server is not reachable: TypeError: Failed to fetch/,
		),
	).toBeTruthy();
	expect(screen.getByText("Loading the care profile…")).toBeTruthy();
	carePlan.unmount();

	renderRoute("/care/sharing");
	expect(await screen.findByText("Could not load sharing")).toBeTruthy();
});

test("choosing another person reads that person's plan", async () => {
	signIn();
	const other = { ...FAMILY, id: "fam-2", name: "Grandpa Joe" };
	const calls = serve({
		...plan(["health_records"]),
		...plan(["health_records"], "/api/families/fam-2"),
		"GET /api/families": { families: [FAMILY, other] },
		"GET /api/families/fam-2/care-profile/prompt": {
			lines: ["Your name is Joe."],
		},
	});

	renderRoute("/care/plan");

	expect(await screen.findByText("Your name is Rose.")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("Person"), {
		target: { value: "fam-2" },
	});

	expect(await screen.findByText("Your name is Joe.")).toBeTruthy();
	expect(screen.queryByText("Your name is Rose.")).toBeNull();
	expect(localStorage.getItem("telly.family")).toBe("fam-2");
	expect(
		calls.some((call) => call.path === "/api/families/fam-2/care-access"),
	).toBe(true);
});
