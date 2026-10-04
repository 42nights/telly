import "../test/setup";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { FamilyAnswer, VoiceAnswer } from "@health/contracts/ask";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, installDom, render, serve, waitFor } from "../test/dom";

import type { EmergencyIntent } from "./logic";
import { Request, startRecording } from "./request";

installDom();

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ASK = "POST /api/families/1/ask";
const VOICE = `POST /api/families/1/ask/voice?asker=wearer&timeZone=${encodeURIComponent(zone)}`;
const SPEECH = "POST /api/families/1/voice/speech";

const answer = (extra: Partial<FamilyAnswer> = {}): FamilyAnswer => ({
	answer: "Your daughter visits on Sunday.",
	evidence: [],
	alerts: [],
	unavailable: [],
	model: "gemini",
	answeredAt: "2026-10-04T08:00:00.000Z",
	followUps: [],
	urgent: false,
	...extra,
});
const voice = (
	text: string,
	extra: Partial<VoiceAnswer> = {},
): { json: VoiceAnswer } => ({
	json: {
		transcript: { text, languageCode: "es", languageProbability: 0.9 },
		answer: answer({ answer: "Tu hija viene el domingo." }),
		speech: { status: "ok", languageCode: "es", audio: "AAAA" },
		...extra,
	},
});

/** Renders the request screen in a router with a medicine page, so navigation shows. */
const show = (familyId: string | null = "1", talkNote = "Loading…") => {
	const onEmergency = mock((_intent: EmergencyIntent, _report: string) => {});
	const root = createRootRoute({
		component: () => (
			<>
				<Request
					familyId={familyId}
					onEmergency={onEmergency}
					talkNote={talkNote}
				/>
				<Outlet />
			</>
		),
	});
	const medicine = createRoute({
		getParentRoute: () => root,
		path: "/medicine",
		component: () => <p>Medicine finder</p>,
	});
	const router = createRouter({
		routeTree: root.addChildren([medicine]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const view = render(<RouterProvider router={router} />);
	return { view, router, onEmergency };
};

/** The two queries the helpers use. */
type View = {
	findByRole: (role: string, options: { name: string }) => Promise<HTMLElement>;
	getByRole: (role: string, options: { name: string }) => HTMLElement;
};

const type = async (view: View, text: string) => {
	fireEvent.change(
		await view.findByRole("textbox", { name: "Type a question" }),
		{ target: { value: text } },
	);
	fireEvent.click(view.getByRole("button", { name: "Send" }));
};

// A microphone and recorder that hand over `chunks` when stopped.
const tracks: string[] = [];
let chunks: Blob[] = [];
class FakeRecorder {
	state: "inactive" | "recording" = "inactive";
	readonly mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		for (const data of chunks) this.ondataavailable?.({ data });
		this.onstop?.();
	}
}
const microphone = (getUserMedia: () => Promise<unknown>) => {
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
	Object.assign(globalThis, { MediaRecorder: FakeRecorder });
};
const granted = () =>
	microphone(() =>
		Promise.resolve({ getTracks: () => [{ stop: () => tracks.push("mic") }] }),
	);
afterEach(() => {
	Reflect.deleteProperty(navigator, "mediaDevices");
	Reflect.deleteProperty(globalThis, "MediaRecorder");
	tracks.length = 0;
	chunks = [new Blob(["voice"], { type: "audio/webm" })];
});
chunks = [new Blob(["voice"], { type: "audio/webm" })];

/** Talks, then stops the recording, which sends it. */
const talk = async (view: View) => {
	fireEvent.click(await view.findByRole("button", { name: "Talk" }));
	fireEvent.click(await view.findByRole("button", { name: "Stop" }));
};

// Like a real fetch that never answers: it ends only when aborted. Keeps each request's signal.
const signals: AbortSignal[] = [];
const hang = () => {
	serve({});
	signals.length = 0;
	globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		const signal = init?.signal;
		if (signal) {
			signals.push(signal);
			signal.addEventListener("abort", () => reject(signal.reason));
		}
		return promise;
	}) as typeof fetch;
};

describe("typed requests", () => {
	test("without a family Talk is off and says why; a question fails as signed out", async () => {
		const calls = serve({});
		const { view } = show(null, "Pair a family to talk.");
		expect(
			(await view.findByRole("button", { name: "Talk" })).hasAttribute(
				"disabled",
			),
		).toBe(true);
		expect(view.getByText("Pair a family to talk.")).toBeDefined();
		await type(view, "When is my daughter coming?");
		expect(await view.findByText("Sign in to ask questions.")).toBeDefined();
		expect(
			view.getByText("Sign-in is not set up on this server."),
		).toBeDefined();
		expect(view.getByText("“When is my daughter coming?”")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Try again" }));
		expect(await view.findByText("Sign in to ask questions.")).toBeDefined();
		expect(calls).toEqual([]);
	});

	test("an empty question sends nothing", async () => {
		const calls = serve({});
		const { view } = show();
		await type(view, "   ");
		expect(
			view.getByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
		expect(calls).toEqual([]);
	});

	test("an urgent request opens help before any model and reports the emergency", async () => {
		const calls = serve({});
		const { view, onEmergency } = show();
		await type(view, "  I fell  ");
		expect(await view.findByText("This sounds urgent.")).toBeDefined();
		expect(view.getByText("“I fell”")).toBeDefined();
		expect(onEmergency.mock.calls).toEqual([["help", "I fell"]]);
		expect(calls).toEqual([]);
		fireEvent.click(view.getByRole("button", { name: "Not urgent? Go back" }));
		expect(
			await view.findByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
	});

	test("an ouch starts the check-in and keeps the request screen", async () => {
		const calls = serve({});
		const { view, onEmergency } = show();
		await type(view, "ouch");
		expect(onEmergency.mock.calls).toEqual([["ouch", "ouch"]]);
		expect(
			view.getByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
		expect(calls).toEqual([]);
	});

	test("a medicine request opens the medicine finder with the words", async () => {
		const calls = serve({});
		const { view, router } = show();
		await type(view, "Where are my meds?");
		expect(await view.findByText("Medicine finder")).toBeDefined();
		expect(router.state.location.search).toEqual({ q: "Where are my meds?" });
		expect(calls).toEqual([]);
	});

	test("a question goes to Gemini with the calm-support rules and the answer is read aloud", async () => {
		const calls = serve({
			[ASK]: { json: answer() },
			[SPEECH]: { json: {} },
		});
		const { view } = show();
		await type(view, "When is my daughter coming?");
		expect(
			await view.findByText("Your daughter visits on Sunday."),
		).toBeDefined();
		expect(await view.findByText("Speaking…")).toBeDefined();
		expect(calls.map((c) => [`${c.method} ${c.path}`, c.body])).toEqual([
			[
				ASK,
				{
					question: "When is my daughter coming?",
					timeZone: zone,
					asker: "wearer",
				},
			],
			[SPEECH, { text: "Your daughter visits on Sunday." }],
		]);
		fireEvent.click(view.getByRole("button", { name: "Ask something else" }));
		expect(
			await view.findByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
	});

	test("Cancel while thinking stops the request and refills the question", async () => {
		hang();
		const { view } = show();
		await type(view, "When is lunch?");
		expect(await view.findByText("Thinking…")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Cancel" }));
		const box = await view.findByRole("textbox", { name: "Type a question" });
		expect((box as HTMLInputElement).value).toBe("When is lunch?");
		expect(signals.map((s) => s.aborted)).toEqual([true]);
	});

	test("leaving the screen while thinking aborts the request", async () => {
		hang();
		const { view } = show();
		await type(view, "When is lunch?");
		expect(await view.findByText("Thinking…")).toBeDefined();
		expect(signals.map((s) => s.aborted)).toEqual([false]);
		view.unmount();
		expect(signals.map((s) => s.aborted)).toEqual([true]);
	});

	test("a failed answer says why, keeps the request, and Try again sends it again", async () => {
		const failures = [
			[
				{
					status: 503,
					body: { error: "unavailable", message: "Gemini is off" },
				},
				"Answers are not available right now.",
				"Gemini is off",
			],
			[
				{ status: 403, body: { error: "forbidden", message: "Not a member" } },
				"You can't ask about this person.",
				"Not a member",
			],
			[
				{ status: 500, body: { error: "internal", message: "Broken" } },
				"Something went wrong while getting the answer.",
				"Broken",
			],
		] as const;
		for (const [reply, title, detail] of failures) {
			const calls = serve({ [ASK]: reply });
			const { view } = show();
			await type(view, "When is lunch?");
			expect(await view.findByText(title)).toBeDefined();
			expect(view.getByText(detail)).toBeDefined();
			expect(view.getByText("I can't answer right now.")).toBeDefined();
			fireEvent.click(view.getByRole("button", { name: "Try again" }));
			await waitFor(() => expect(calls).toHaveLength(2));
			expect(await view.findByText(title)).toBeDefined();
			expect(calls[1]?.body).toEqual(calls[0]?.body);
			view.unmount();
		}
	});

	test("I need help now under a failure opens the help panel", async () => {
		serve({ [ASK]: { status: 500 } });
		const { view } = show();
		await type(view, "When is lunch?");
		fireEvent.click(
			await view.findByRole("button", { name: "I need help now" }),
		);
		expect(await view.findByText("This sounds urgent.")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Not urgent? Go back" }));
		expect(
			await view.findByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
	});
});

describe("Talk", () => {
	test("a denied or missing microphone says what to do", async () => {
		for (const [error, problem] of [
			[
				new DOMException("denied", "NotAllowedError"),
				"Allow the microphone for this site, then press Talk again.",
			],
			[
				Object.assign(new Error("insecure"), { name: "SecurityError" }),
				"Allow the microphone for this site, then press Talk again.",
			],
			[
				new DOMException("none", "NotFoundError"),
				"No microphone is available. Type your question instead.",
			],
			[
				"not an error",
				"No microphone is available. Type your question instead.",
			],
		] as const) {
			serve({});
			microphone(() => Promise.reject(error));
			const { view } = show();
			fireEvent.click(await view.findByRole("button", { name: "Talk" }));
			expect((await view.findByRole("alert")).textContent).toBe(problem);
			view.unmount();
		}
	});

	test("Stop sends the recording and shows the spoken answer in its language", async () => {
		granted();
		const calls = serve({ [VOICE]: voice("¿Cuándo viene mi hija?") });
		const { view } = show();
		fireEvent.click(await view.findByRole("button", { name: "Talk" }));
		expect(await view.findByText("I'm listening…")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Stop" }));
		expect(await view.findByText("Tu hija viene el domingo.")).toBeDefined();
		expect(view.getByText("“¿Cuándo viene mi hija?”")).toBeDefined();
		expect(view.getByText(/^You said \(heard in /)).toBeDefined();
		// The answer came with its MP3, so no speech is requested.
		expect(await view.findByText("Speaking…")).toBeDefined();
		expect(tracks).toEqual(["mic"]);
		expect(calls).toHaveLength(1);
		const body = calls[0]?.body;
		expect(body instanceof Blob && (await body.text())).toBe("voice");
	});

	test("an answer without speech says why", async () => {
		granted();
		serve({
			[VOICE]: voice("¿Cuándo viene mi hija?", {
				speech: { status: "unavailable", message: "Voice is off" },
			}),
			[SPEECH]: { status: 503 },
		});
		const { view } = show();
		await talk(view);
		expect(
			await view.findByText("No spoken answer this time: Voice is off"),
		).toBeDefined();
		expect(
			await view.findByText("The voice is not available right now."),
		).toBeDefined();
	});

	test("a silent recording asks to try again and sends nothing", async () => {
		granted();
		chunks = [];
		const calls = serve({});
		const { view } = show();
		await talk(view);
		expect((await view.findByRole("alert")).textContent).toBe(
			"I didn't hear anything. Try again.",
		);
		expect(calls).toEqual([]);
	});

	test("an untyped recording is sent as webm", async () => {
		granted();
		chunks = [new Blob(["voice"])];
		const calls = serve({ [VOICE]: voice("¿Cuándo viene mi hija?") });
		const { view } = show();
		await talk(view);
		expect(await view.findByText("Tu hija viene el domingo.")).toBeDefined();
		expect(calls).toHaveLength(1);
	});

	test("an urgent spoken request opens help; the server's urgent flag counts too", async () => {
		for (const [said, urgent] of [
			["I fell", false],
			["my arm feels strange", true],
		] as const) {
			granted();
			serve({
				[VOICE]: voice(said, { answer: answer({ urgent, model: "none" }) }),
			});
			const { view, onEmergency } = show();
			await talk(view);
			expect(await view.findByText("This sounds urgent.")).toBeDefined();
			expect(view.getByText(`“${said}”`)).toBeDefined();
			expect(onEmergency.mock.calls).toEqual([["help", said]]);
			view.unmount();
		}
	});

	test("a spoken ouch starts the check-in and returns to the request screen", async () => {
		granted();
		serve({ [VOICE]: voice(" ouch ") });
		const { view, onEmergency } = show();
		await talk(view);
		expect(
			await view.findByRole("heading", { name: "What do you need?" }),
		).toBeDefined();
		expect(onEmergency.mock.calls).toEqual([["ouch", "ouch"]]);
	});

	test("a spoken medicine request opens the medicine finder", async () => {
		granted();
		serve({ [VOICE]: voice("where are my pills") });
		const { view, router } = show();
		await talk(view);
		expect(await view.findByText("Medicine finder")).toBeDefined();
		expect(router.state.location.search).toEqual({ q: "where are my pills" });
	});

	test("Talk unavailable offers typing; Try again sends the same recording", async () => {
		granted();
		const calls = serve({
			[VOICE]: {
				status: 503,
				body: { error: "unavailable", message: "ElevenLabs is off" },
			},
		});
		const { view } = show();
		await talk(view);
		expect(
			await view.findByText(
				"Talk is not available right now. You can type your question.",
			),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1]?.body).toBe(calls[0]?.body);
		expect(await view.findByText("ElevenLabs is off")).toBeDefined();
	});

	test("another voice failure shows its own title", async () => {
		granted();
		serve({ [VOICE]: { status: 500 } });
		const { view } = show();
		await talk(view);
		expect(
			await view.findByText("Something went wrong while getting the answer."),
		).toBeDefined();
	});

	test("Cancel while a recording is answered returns to an empty request", async () => {
		granted();
		hang();
		const { view } = show();
		await talk(view);
		fireEvent.click(await view.findByRole("button", { name: "Cancel" }));
		const box = await view.findByRole("textbox", { name: "Type a question" });
		expect((box as HTMLInputElement).value).toBe("");
		expect(signals.map((s) => s.aborted)).toEqual([true]);
	});

	test("leaving the screen while listening drops the recording", async () => {
		granted();
		const calls = serve({});
		const { view } = show();
		fireEvent.click(await view.findByRole("button", { name: "Talk" }));
		expect(await view.findByText("I'm listening…")).toBeDefined();
		view.unmount();
		expect(tracks).toEqual(["mic"]);
		expect(calls).toEqual([]);
	});
});

describe("startRecording", () => {
	test("stops by itself at the one-minute cap", async () => {
		granted();
		const timers: (() => void)[] = [];
		const realTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			if (ms === 60_000) timers.push(fn);
			return realTimeout(() => {}, 0);
		}) as typeof setTimeout;
		const heard: Blob[] = [];
		try {
			const recording = await startRecording((audio) => heard.push(audio));
			expect(typeof recording).toBe("object");
			for (const fire of timers) fire();
		} finally {
			globalThis.setTimeout = realTimeout;
		}
		expect(heard).toHaveLength(1);
		expect(tracks).toEqual(["mic"]);
	});

	test("a second stop does not stop the recorder again", async () => {
		granted();
		const heard: Blob[] = [];
		const recording = await startRecording((audio) => heard.push(audio));
		if (typeof recording === "string") throw new Error(recording);
		recording.stop();
		recording.stop();
		expect(heard).toHaveLength(1);
		expect(tracks).toEqual(["mic", "mic"]);
	});
});
