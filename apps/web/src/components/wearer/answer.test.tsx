import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import type { Evidence } from "@health/contracts/chat";
import { FakeAudio, installFakeAudio } from "../test/audio";
import {
	act,
	fireEvent,
	installDom,
	render,
	serve,
	waitFor,
} from "../test/dom";
import { AnswerFailed, AnswerPanel, Asked, type Reply } from "./answer";

installDom();
installFakeAudio();

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

const sample = (id: string, metric: string, synthetic = false): Evidence => ({
	id,
	familyId: "f1",
	metric,
	value: 72,
	unit: "bpm",
	sourceTime: "2026-10-04T11:57:00.000Z",
	receivedAt: "2026-10-04T11:57:00.000Z",
	source: "phone",
	synthetic,
	quality: "validated",
	stale: false,
});

const reply = (over: Partial<Reply> = {}): Reply => ({
	id: "r1",
	asked: "How is my heart?",
	answer: {
		answer: "Your heart rate was 72.",
		evidence: [],
		alerts: [],
		unavailable: [],
		model: "gemini",
		answeredAt: "2026-10-04T12:00:00.000Z",
		followUps: [],
		urgent: false,
	},
	audio: "SUQz",
	languageCode: null,
	voiceNote: null,
	...over,
});

describe("Asked", () => {
	test("quotes a typed request", () => {
		const view = render(<Asked asked="Where am I?" />);
		expect(view.getByText("You asked")).toBeDefined();
		expect(view.getByText("“Where am I?”").getAttribute("lang")).toBeNull();
	});

	test("names the language heard in a spoken request", () => {
		const view = render(<Asked asked="¿Dónde estoy?" languageCode="es" />);
		expect(view.getByText("You said (heard in Spanish)")).toBeDefined();
		expect(view.getByText("“¿Dónde estoy?”").getAttribute("lang")).toBe("es");
	});
});

describe("AnswerPanel", () => {
	test("speaks the MP3 once on arrival, and Stop, Say it again, and Slower control it", async () => {
		const calls = serve({});
		const onDone = mock();
		const view = render(
			<AnswerPanel
				familyId="f1"
				onDone={onDone}
				reply={reply()}
				support={<p>Call Ana</p>}
			/>,
		);
		expect(view.getByText("Your heart rate was 72.")).toBeDefined();
		expect(view.getByText("Call Ana")).toBeDefined();
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Speaking…"),
		);
		expect(FakeAudio.made.map((a) => a.src)).toEqual([
			"data:audio/mpeg;base64,SUQz",
		]);
		expect(view.queryByRole("list")).toBeNull();

		fireEvent.click(view.getByRole("button", { name: "Stop" }));
		expect(FakeAudio.made[0]?.paused).toBe(true);
		expect(view.queryByRole("status")).toBeNull();

		fireEvent.click(view.getByRole("button", { name: "Slower" }));
		await waitFor(() => expect(FakeAudio.made.length).toBe(2));
		expect(FakeAudio.made[1]?.playbackRate).toBe(0.75);
		act(() => FakeAudio.made[1]?.onended?.());

		fireEvent.click(view.getByRole("button", { name: "Say it again" }));
		await waitFor(() => expect(FakeAudio.made.length).toBe(3));
		expect(FakeAudio.made[2]?.playbackRate).toBe(1);

		view.rerender(
			<AnswerPanel
				familyId="f1"
				onDone={onDone}
				reply={reply()}
				support={<p>Call Ana</p>}
			/>,
		);
		expect(FakeAudio.made.length).toBe(3);
		expect(calls).toEqual([]);

		fireEvent.click(view.getByRole("button", { name: "Ask something else" }));
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	test("asks for speech in the heard language when no MP3 came, and says why", async () => {
		const calls = serve({
			"POST /api/families/f1/voice/speech": { json: "mp3" },
		});
		const view = render(
			<AnswerPanel
				familyId="f1"
				onDone={() => {}}
				reply={reply({
					audio: null,
					languageCode: "es",
					voiceNote: "The voice was busy.",
				})}
				support={null}
			/>,
		);
		expect(view.getByText("The voice was busy.")).toBeDefined();
		expect(view.getByText("Your heart rate was 72.").getAttribute("lang")).toBe(
			"es",
		);
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Speaking…"),
		);
		expect(calls[0]?.body).toEqual({
			text: "Your heart rate was 72.",
			languageCode: "es",
		});
	});

	test("shows a voice failure under the answer, and offers to say it again", async () => {
		serve({});
		const view = render(
			<AnswerPanel
				familyId={null}
				onDone={() => {}}
				reply={reply({ audio: null })}
				support={null}
			/>,
		);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe(
				"Sign in to hear this read aloud.",
			),
		);
		expect(view.getByRole("button", { name: "Say it again" })).toBeDefined();
		expect(FakeAudio.made).toEqual([]);
	});

	test("lists up to three sources and what had no records, and flags demo data", async () => {
		serve({});
		const error = spyOn(console, "error").mockImplementation(() => {});
		const view = render(
			<AnswerPanel
				familyId="f1"
				onDone={() => {}}
				reply={reply({
					answer: {
						...reply().answer,
						evidence: [
							sample("1", "heart_rate"),
							sample("2", "steps", true),
							sample("3", "spo2"),
							sample("4", "weight"),
						],
						unavailable: ["blood_pressure", "health_samples"],
					},
				})}
				support={null}
			/>,
		);
		expect(view.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Heart rate 72 bpm · from phone · 3 min ago",
			"Steps 72 bpm · from phone · 3 min ago (demo, not real)",
			"SpO2 72 bpm · from phone · 3 min ago",
			"No records for: blood pressure, health samples",
		]);
		expect(error).toHaveBeenCalledWith(
			"The answer cites 1 demo samples that are not real readings (steps).",
		);
		error.mockRestore();
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Speaking…"),
		);
	});
});

describe("AnswerFailed", () => {
	test("says no answer came, with the reason, and offers to retry or ask again", () => {
		const onRetry = mock();
		const onDone = mock();
		const view = render(
			<AnswerFailed
				asked="Where am I?"
				detail="HTTP 503"
				onDone={onDone}
				onRetry={onRetry}
				support={<p>Call Ana</p>}
				title="The answer service is not available."
			/>,
		);
		expect(view.getByText("“Where am I?”")).toBeDefined();
		expect(view.getByRole("alert").textContent).toBe(
			"I can't answer right now.The answer service is not available.HTTP 503",
		);
		expect(view.getByText("Call Ana")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Try again" }));
		fireEvent.click(view.getByRole("button", { name: "Ask something else" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	test("shows no quote when nothing was heard", () => {
		const view = render(
			<AnswerFailed
				asked={null}
				detail="d"
				onDone={() => {}}
				onRetry={() => {}}
				support={null}
				title="t"
			/>,
		);
		expect(view.queryByText("You asked")).toBeNull();
	});
});
