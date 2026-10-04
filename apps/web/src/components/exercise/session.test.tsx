// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	ExerciseEventInput,
	ExercisePlan,
	ExerciseSession,
} from "@health/contracts/exercise";

import {
	act,
	type Call,
	fireEvent,
	type Reply,
	render,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom-routed";
import { ExerciseInvite } from "./session";

setupDom();

const RECORDS = "GET /api/families/f1/exercise";
const EVENTS = "POST /api/families/f1/exercise/events";
const SPEECH = "POST /api/families/f1/voice/speech";
// 10:00 local time, inside the 09:00–11:00 window.
const NOW = new Date(2026, 9, 4, 10, 0).getTime();
const HEX = "a".repeat(64);

const makePlan = (over: Partial<ExercisePlan> = {}): ExercisePlan => ({
	id: "p1",
	activity: "Chair march",
	steps: ["Sit tall.", "Lift each knee."],
	demands: [],
	restrictions: [],
	source: "Physiotherapist handout",
	windowStart: "09:00",
	windowEnd: "11:00",
	videoUrl: null,
	createdBy: HEX,
	createdAt: "2026-10-01T08:00:00.000Z",
	verification: { verifiedBy: HEX, verifiedAt: "2026-10-01T09:00:00.000Z" },
	...over,
});

const saved = (call: Call): Reply => {
	const event = call.body as ExerciseEventInput;
	const session: ExerciseSession = {
		sessionId: event.sessionId,
		planId: event.planId,
		outcome: "unfinished",
		reason: null,
		help: false,
		openedAt: "2026-10-04T10:00:00.000Z",
		endedAt: null,
	};
	return { json: session };
};

/** Serves one plan, saves every event, and answers speech with a short MP3. */
const start = (
	plan: ExercisePlan = makePlan(),
	events: (call: Call) => Reply = saved,
) => {
	signIn();
	const calls = serve({
		[RECORDS]: { json: { plans: [plan], sessions: [] } },
		[EVENTS]: events,
		[SPEECH]: { blob: new Blob(["mp3"], { type: "audio/mpeg" }) },
	});
	const view = render(<ExerciseInvite familyId="f1" now={NOW} />);
	const sent = () =>
		calls
			.filter((c) => c.path.endsWith("/exercise/events"))
			.map((c) => c.body as ExerciseEventInput);
	return { calls, view, sent };
};

test("a due plan invites the wearer; Not now records a decline and Close hides it", async () => {
	const { calls, view, sent } = start();
	expect(
		await view.findByRole("heading", { name: "Chair march" }),
	).toBeDefined();
	expect(
		view.getByText("Agreed activity from: Physiotherapist handout"),
	).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "Not now" }));
	expect((await view.findByRole("status")).textContent).toBe(
		"That's fine. I won't ask again today.",
	);
	expect(sent()).toEqual([
		expect.objectContaining({ planId: "p1", kind: "declined", reason: null }),
	]);
	fireEvent.click(view.getByRole("button", { name: "Close" }));
	// The list is read again, and the answered plan is not offered again even before it shows there.
	await waitFor(() =>
		expect(
			calls.filter((c) => c.path === "/api/families/f1/exercise"),
		).toHaveLength(2),
	);
	expect(view.queryByRole("region", { name: "Exercise" })).toBeNull();
});

test("a full session: start, pause, resume, repeat, slower, next step, finish", async () => {
	const { calls, view, sent } = start();
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	expect(await view.findByText("Step 1 of 2")).toBeDefined();
	expect(view.getByText("Sit tall.")).toBeDefined();
	expect(
		view.getByText(
			"This activity has no video. Follow the words and the voice.",
		),
	).toBeDefined();
	// The first step is read aloud.
	await waitFor(() =>
		expect(calls.find((c) => c.path.endsWith("/voice/speech"))?.body).toEqual({
			text: "Sit tall.",
		}),
	);
	expect((await view.findByRole("status")).textContent).toBe("Speaking…");

	fireEvent.click(view.getByRole("button", { name: "Pause" }));
	expect(await view.findByText("Step 1 of 2 · Paused")).toBeDefined();
	expect(view.queryByRole("status")).toBeNull();
	expect(
		view.getByRole("button", { name: "Next step" }).hasAttribute("disabled"),
	).toBe(true);

	fireEvent.click(view.getByRole("button", { name: "Resume" }));
	expect(await view.findByText("Step 1 of 2")).toBeDefined();
	expect((await view.findByRole("status")).textContent).toBe("Speaking…");

	fireEvent.click(view.getByRole("button", { name: "Repeat" }));
	await waitFor(() => expect(sent().at(-1)?.kind).toBe("repeated"));

	fireEvent.click(view.getByRole("button", { name: "Slower" }));
	expect(await view.findByText("Step 1 of 2 · Slower")).toBeDefined();
	expect(
		view.getByRole("button", { name: "Slower" }).hasAttribute("disabled"),
	).toBe(true);

	fireEvent.click(view.getByRole("button", { name: "Next step" }));
	expect(await view.findByText("Step 2 of 2 · Slower")).toBeDefined();
	expect(view.getByText("Lift each knee.")).toBeDefined();
	await waitFor(() =>
		expect(
			calls.filter((c) => c.path.endsWith("/voice/speech")).at(-1)?.body,
		).toEqual({
			text: "Lift each knee.",
		}),
	);

	fireEvent.click(view.getByRole("button", { name: "I finished" }));
	await waitFor(() =>
		expect(
			view.getByText("You finished the activity. Your family can see it."),
		).toBeDefined(),
	);
	// Moving to the next step records nothing; every recorded event shares one session.
	const events = sent();
	expect(events.map((e) => e.kind)).toEqual([
		"started",
		"paused",
		"resumed",
		"repeated",
		"slowed",
		"completed",
	]);
	expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
	expect(new Set(events.map((e) => e.id)).size).toBe(6);
});

test("Help shows what to do and records it, and the session goes on", async () => {
	const { view, sent } = start();
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	fireEvent.click(view.getByRole("button", { name: "Help" }));
	expect(
		await view.findByText("Sit down somewhere safe and rest."),
	).toBeDefined();
	await waitFor(() => expect(sent().at(-1)?.kind).toBe("help"));
	expect(view.getByText("Step 1 of 2")).toBeDefined();
});

test("Stop records the wearer's choice and shows no help note", async () => {
	const { view, sent } = start();
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	fireEvent.click(view.getByRole("button", { name: "Stop" }));
	expect(
		await view.findByText("You stopped the activity. Your family can see it."),
	).toBeDefined();
	expect(sent().at(-1)).toEqual(
		expect.objectContaining({ kind: "stopped", reason: "wearer" }),
	);
	expect(view.queryByText("Sit down somewhere safe and rest.")).toBeNull();
});

test("Pain stops the session with its reason and shows the help note", async () => {
	const { view, sent } = start();
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	fireEvent.click(view.getByRole("button", { name: "Pain" }));
	expect(
		await view.findByText("You stopped the activity. Your family can see it."),
	).toBeDefined();
	expect(sent().at(-1)).toEqual(
		expect.objectContaining({ kind: "stopped", reason: "pain" }),
	);
	expect(view.getByText("Sit down somewhere safe and rest.")).toBeDefined();
});

test("a failed save shows why, and Try again resends the same event once", async () => {
	let fail = true;
	const { view, sent } = start(makePlan(), (call) =>
		fail
			? {
					status: 503,
					json: { error: "internal", message: "Storage is down." },
				}
			: saved(call),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	expect((await view.findByRole("alert")).textContent).toContain(
		"This was not saved. Storage is down.",
	);
	// Still invited: nothing started.
	expect(view.getByRole("button", { name: "Start" })).toBeDefined();
	fail = false;
	fireEvent.click(view.getByRole("button", { name: "Try again" }));
	expect(await view.findByText("Step 1 of 2")).toBeDefined();
	expect(view.queryByRole("alert")).toBeNull();
	const [first, retry] = sent();
	expect(retry).toEqual(first);
});

test("a control that fails to save leaves the session as it was", async () => {
	let fail = false;
	const { view } = start(makePlan(), (call) =>
		fail ? { status: 500 } : saved(call),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	fail = true;
	fireEvent.click(view.getByRole("button", { name: "Pause" }));
	expect((await view.findByRole("alert")).textContent).toContain(
		"This was not saved. The server is busy or had a problem (HTTP 500).",
	);
	expect(view.getByText("Step 1 of 2")).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "Repeat" }));
	fireEvent.click(view.getByRole("button", { name: "Slower" }));
	await waitFor(() =>
		expect(view.getAllByRole("alert").length).toBeGreaterThan(0),
	);
	expect(view.getByText("Step 1 of 2")).toBeDefined();
	expect(view.getByRole("button", { name: "Pause" })).toBeDefined();
});

test("a safety stop shows the help note even when saving the stop fails", async () => {
	let fail = false;
	const { view } = start(makePlan(), (call) =>
		fail ? { status: 500 } : saved(call),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	fail = true;
	fireEvent.click(view.getByRole("button", { name: "Dizzy" }));
	expect(
		await view.findByText("Sit down somewhere safe and rest."),
	).toBeDefined();
	expect((await view.findByRole("alert")).textContent).toContain(
		"This was not saved.",
	);
});

test("a save refused for the session ends it, and the invitation goes away", async () => {
	const { view } = start(makePlan(), () => ({ status: 401 }));
	fireEvent.click(await view.findByRole("button", { name: "Not now" }));
	await waitFor(() => {
		if (view.queryByRole("heading", { name: "Chair march" }) !== null)
			throw new Error("still invited");
	});
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});

test("with a video, Pause, Resume, Repeat, Slower, and Stop drive the video", async () => {
	const { view } = start(
		makePlan({ videoUrl: "https://video.test/march.mp4" }),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	const video = view.container.querySelector("video");
	if (video === null) throw new Error("no video");
	expect(video.getAttribute("src")).toBe("https://video.test/march.mp4");
	await act(() => video.play());

	fireEvent.click(view.getByRole("button", { name: "Pause" }));
	await view.findByText("Step 1 of 2 · Paused");
	expect(video.paused).toBe(true);
	fireEvent.click(view.getByRole("button", { name: "Resume" }));
	await view.findByText("Step 1 of 2");
	await waitFor(() => expect(video.paused).toBe(false));

	video.currentTime = 12;
	fireEvent.click(view.getByRole("button", { name: "Repeat" }));
	await waitFor(() => expect(video.currentTime).toBe(0));

	fireEvent.click(view.getByRole("button", { name: "Slower" }));
	await view.findByText("Step 1 of 2 · Slower");
	expect(video.playbackRate).toBe(0.75);

	fireEvent.click(view.getByRole("button", { name: "Stop" }));
	await view.findByText("You stopped the activity. Your family can see it.");
	expect(video.paused).toBe(true);
});

test("a video the browser refuses to play leaves the session running", async () => {
	const { view, sent } = start(
		makePlan({ videoUrl: "https://video.test/march.mp4" }),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	const video = view.container.querySelector("video");
	if (video === null) throw new Error("no video");
	video.play = () => Promise.reject(new Error("NotAllowedError"));
	fireEvent.click(view.getByRole("button", { name: "Pause" }));
	await view.findByText("Step 1 of 2 · Paused");
	fireEvent.click(view.getByRole("button", { name: "Resume" }));
	await view.findByText("Step 1 of 2");
	fireEvent.click(view.getByRole("button", { name: "Repeat" }));
	await waitFor(() => expect(sent().at(-1)?.kind).toBe("repeated"));
	expect(view.queryByRole("alert")).toBeNull();
	expect(
		view.getByRole("button", { name: "Next step" }).hasAttribute("disabled"),
	).toBe(false);
});

test("a video that does not load falls back to words and voice", async () => {
	const { view } = start(
		makePlan({ videoUrl: "https://video.test/missing.mp4" }),
	);
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	const video = view.container.querySelector("video");
	if (video === null) throw new Error("no video");
	fireEvent.error(video);
	expect(
		await view.findByText(
			"The video did not load. Follow the words and the voice.",
		),
	).toBeDefined();
	expect(view.container.querySelector("video")).toBeNull();
});

test("once answered, the session stays even after its window closes", async () => {
	const { view } = start();
	fireEvent.click(await view.findByRole("button", { name: "Start" }));
	await view.findByText("Step 1 of 2");
	view.rerender(
		<ExerciseInvite
			familyId="f1"
			now={new Date(2026, 9, 4, 12, 0).getTime()}
		/>,
	);
	expect(view.getByText("Step 1 of 2")).toBeDefined();
});

test("no due plan shows nothing: outside the window, or not yet confirmed", async () => {
	signIn();
	const calls = serve({
		[RECORDS]: {
			json: {
				plans: [
					makePlan({ verification: null }),
					makePlan({ id: "p2", windowStart: "14:00", windowEnd: "15:00" }),
				],
				sessions: [],
			},
		},
	});
	const view = render(<ExerciseInvite familyId="f1" now={NOW} />);
	await waitFor(() => expect(calls).toHaveLength(1));
	await act(() => Promise.resolve());
	expect(view.container.innerHTML).toBe("");
});

test("signed out, nothing shows and nothing is read", async () => {
	const calls = serve({});
	const view = render(<ExerciseInvite familyId="f1" now={NOW} />);
	await act(() => Promise.resolve());
	expect(view.container.innerHTML).toBe("");
	expect(calls).toHaveLength(0);
});

test("an unreadable list shows as unavailable, not as nothing to do", async () => {
	signIn();
	serve({
		[RECORDS]: { status: 503, json: { error: "internal", message: "Down." } },
	});
	const view = render(<ExerciseInvite familyId="f1" now={NOW} />);
	expect(
		await view.findByText("Exercise invitations are unavailable: Down."),
	).toBeDefined();
});
