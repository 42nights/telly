// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { expect, test } from "bun:test";
import type {
	ExercisePlan,
	ExerciseRecords,
	ExerciseSession,
} from "@health/contracts/exercise";
import type { RenderResult } from "@testing-library/react";

import {
	fireEvent,
	type Reply,
	render,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom";
import { ExerciseSection } from "./plans";

setupDom();

const RECORDS = "GET /api/families/f1/exercise";
const PLANS = "POST /api/families/f1/exercise/plans";
const VERIFY = "POST /api/families/f1/exercise/plans/p1/verify";
const HEX = "a".repeat(64);

const makePlan = (over: Partial<ExercisePlan> = {}): ExercisePlan => ({
	id: "p1",
	activity: "Chair march",
	steps: ["Sit tall."],
	demands: [],
	restrictions: [],
	source: "Physiotherapist handout",
	windowStart: "09:00",
	windowEnd: "11:00",
	videoUrl: null,
	createdBy: HEX,
	createdAt: "2026-10-01T08:00:00.000Z",
	verification: null,
	...over,
});

const makeSession = (over: Partial<ExerciseSession>): ExerciseSession => ({
	sessionId: "s1",
	planId: "p1",
	outcome: "completed",
	reason: null,
	help: false,
	openedAt: "2026-10-03T10:00:00.000Z",
	endedAt: "2026-10-03T10:10:00.000Z",
	...over,
});

const records = (value: ExerciseRecords): Reply => ({ json: value });
const EMPTY = records({ plans: [], sessions: [] });
const fillForm = (view: RenderResult, steps: string) => {
	fireEvent.change(view.getByLabelText("Activity name"), {
		target: { value: "  Chair march " },
	});
	fireEvent.change(
		view.getByLabelText(
			"Steps, one per line, exactly as written in the source",
		),
		{ target: { value: steps } },
	);
	fireEvent.change(view.getByLabelText(/Where it was agreed/), {
		target: { value: " Physio handout " },
	});
};

test("signed out, the section asks to sign in", async () => {
	const { view } = await renderRouted(<ExerciseSection familyId="f1" />);
	expect(
		await view.findByText("Sign in to see exercise.", { exact: false }),
	).toBeDefined();
});

test("with nothing recorded, it says so and does not count silence as exercise", async () => {
	signIn();
	serve({ [RECORDS]: EMPTY });
	const view = render(<ExerciseSection familyId="f1" />);
	expect(await view.findByText("No agreed activity yet.")).toBeDefined();
	expect(
		view.getByText(
			"No sessions recorded yet. No answer is not counted as exercise.",
		),
	).toBeDefined();
});

test("plans show their window and source; sessions show outcome, reason, and help", async () => {
	signIn();
	serve({
		[RECORDS]: records({
			plans: [
				makePlan(),
				makePlan({
					id: "p2",
					activity: "Wall push",
					verification: {
						verifiedBy: HEX,
						verifiedAt: "2026-10-01T09:00:00.000Z",
					},
				}),
			],
			sessions: [
				makeSession({
					sessionId: "s1",
					planId: "p2",
					outcome: "stopped",
					reason: "dizziness",
					help: true,
				}),
				makeSession({ sessionId: "s2", planId: "gone", outcome: "unfinished" }),
			],
		}),
	});
	const view = render(<ExerciseSection familyId="f1" />);
	expect(await view.findByText("Chair march")).toBeDefined();
	expect(view.getAllByText("Source: Physiotherapist handout")).toHaveLength(2);
	expect(
		view.getByRole("button", {
			name: "Not offered yet: confirm it matches the source",
		}),
	).toBeDefined();
	expect(
		view.getByText("Confirmed. It is offered during its time window."),
	).toBeDefined();
	const [stopped, unknown] = view.getAllByRole("listitem").slice(2);
	expect(stopped?.textContent).toContain(
		"Wall push: Stopped (dizziness) · asked for help",
	);
	expect(unknown?.textContent).toContain(
		"Unknown activity: Started, no finish recorded",
	);
	expect(unknown?.textContent).not.toContain("asked for help");
});

test("confirming a plan posts the check and reads the list again", async () => {
	signIn();
	let verified = false;
	const calls = serve({
		[RECORDS]: () =>
			records({
				plans: [
					makePlan(
						verified
							? {
									verification: {
										verifiedBy: HEX,
										verifiedAt: "2026-10-02T09:00:00.000Z",
									},
								}
							: {},
					),
				],
				sessions: [],
			}),
		[VERIFY]: () => {
			verified = true;
			return { json: makePlan() };
		},
	});
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", {
			name: "Not offered yet: confirm it matches the source",
		}),
	);
	expect(
		await view.findByText("Confirmed. It is offered during its time window."),
	).toBeDefined();
	expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
		RECORDS,
		VERIFY,
		RECORDS,
	]);
});

test("a refused confirmation shows the server's reason", async () => {
	signIn();
	serve({
		[RECORDS]: records({ plans: [makePlan()], sessions: [] }),
		[VERIFY]: {
			status: 409,
			json: {
				error: "conflict",
				message: "The care profile forbids standing.",
			},
		},
	});
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", {
			name: "Not offered yet: confirm it matches the source",
		}),
	);
	expect((await view.findByRole("alert")).textContent).toBe(
		"The care profile forbids standing.",
	);
});

test("a confirmation refused for the session ends it and asks to sign in", async () => {
	signIn();
	serve({
		[RECORDS]: records({ plans: [makePlan()], sessions: [] }),
		[VERIFY]: { status: 401 },
	});
	const { view } = await renderRouted(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", {
			name: "Not offered yet: confirm it matches the source",
		}),
	);
	expect(
		await view.findByText("Sign in to see exercise.", { exact: false }),
	).toBeDefined();
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});

test("saving a plan posts the trimmed form, closes it, and reads the list again", async () => {
	signIn();
	const calls = serve({
		[RECORDS]: EMPTY,
		[PLANS]: { json: makePlan() },
	});
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	);
	fillForm(view, " Sit tall.\n\n Lift each knee. \n");
	const [needsStanding] = view.getAllByRole("checkbox", { name: "Standing" });
	if (needsStanding === undefined) throw new Error("missing checkbox");
	fireEvent.click(needsStanding);
	fireEvent.change(view.getByLabelText("Invite from"), {
		target: { value: "08:30" },
	});
	fireEvent.change(view.getByLabelText("Until"), {
		target: { value: "10:15" },
	});
	fireEvent.change(view.getByLabelText(/Video from the same source/), {
		target: { value: " https://video.test/march.mp4 " },
	});
	fireEvent.click(view.getByRole("button", { name: "Save activity" }));
	expect(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	).toBeDefined();
	expect(view.queryByLabelText("Activity name")).toBeNull();
	expect(calls.find((c) => c.method === "POST")?.body).toEqual({
		activity: "Chair march",
		steps: ["Sit tall.", "Lift each knee."],
		demands: ["standing"],
		restrictions: [],
		source: "Physio handout",
		windowStart: "08:30",
		windowEnd: "10:15",
		videoUrl: "https://video.test/march.mp4",
	});
	await waitFor(() =>
		expect(calls.filter((c) => c.method === "GET")).toHaveLength(2),
	);
});

test("a demand that a restriction forbids blocks saving until it is cleared", async () => {
	signIn();
	serve({ [RECORDS]: EMPTY });
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	);
	const [needsFloor, avoidFloor] = view.getAllByRole("checkbox", {
		name: "Getting down to the floor",
	});
	if (needsFloor === undefined || avoidFloor === undefined)
		throw new Error("missing checkbox");
	fireEvent.click(needsFloor);
	fireEvent.click(avoidFloor);
	expect((await view.findByRole("alert")).textContent).toBe(
		"A restriction forbids: Getting down to the floor. Choose another activity.",
	);
	const save = view.getByRole("button", { name: "Save activity" });
	expect(save.hasAttribute("disabled")).toBe(true);
	fireEvent.click(avoidFloor);
	await waitFor(() => {
		if (view.queryByRole("alert") !== null) throw new Error("still shown");
	});
	expect(save.hasAttribute("disabled")).toBe(false);
});

test("a form with only blank steps sends nothing and asks for a step", async () => {
	signIn();
	const calls = serve({ [RECORDS]: EMPTY });
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	);
	fillForm(view, "  \n ");
	fireEvent.submit(view.getByRole("button", { name: "Save activity" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Write at least one step.",
	);
	expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("a refused save keeps the form, sends no video when blank, and shows why", async () => {
	signIn();
	const calls = serve({
		[RECORDS]: EMPTY,
		[PLANS]: {
			status: 400,
			json: { error: "invalid_request", message: "The source is too long." },
		},
	});
	const view = render(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	);
	fillForm(view, "Sit tall.");
	fireEvent.submit(view.getByRole("button", { name: "Save activity" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"The source is too long.",
	);
	expect(view.getByLabelText("Activity name")).toBeDefined();
	expect(calls.find((c) => c.method === "POST")?.body).toEqual(
		expect.objectContaining({ videoUrl: null, windowStart: "09:00" }),
	);
});

test("a save refused for the session ends it and asks to sign in", async () => {
	signIn();
	serve({ [RECORDS]: EMPTY, [PLANS]: { status: 401 } });
	const { view } = await renderRouted(<ExerciseSection familyId="f1" />);
	fireEvent.click(
		await view.findByRole("button", { name: "Add an agreed activity" }),
	);
	fillForm(view, "Sit tall.");
	fireEvent.submit(view.getByRole("button", { name: "Save activity" }));
	expect(
		await view.findByText("Sign in to see exercise.", { exact: false }),
	).toBeDefined();
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});
