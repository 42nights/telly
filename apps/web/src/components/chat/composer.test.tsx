// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { QuestionAttachment } from "@health/contracts/ask";
import type { VoiceTranscript } from "@health/contracts/voice";
import type { RenderResult } from "@testing-library/react";
import { useRef, useState } from "react";

import type { ApiResult } from "@/lib/api";
import type { Outcome } from "@/lib/pending";

import {
	fireEvent,
	render,
	setupDom,
	waitFor,
	within,
} from "../test/dom-routed";
import { Composer } from "./composer";
import { ASK_AGENT, type ChatTarget } from "./logic";

setupDom();

const FILES_TIP = "Files go only to the family agent";

function Harness({
	initial,
	offline,
	agent,
	family,
}: {
	initial: ChatTarget;
	offline: boolean;
	agent: Parameters<typeof Composer>[0]["agent"];
	family: Parameters<typeof Composer>[0]["family"];
}) {
	const [draft, setDraft] = useState("");
	const [target, setTarget] = useState(initial);
	const input = useRef<HTMLTextAreaElement>(null);
	return (
		<Composer
			draft={draft}
			setDraft={setDraft}
			input={input}
			target={target}
			onTarget={setTarget}
			placeholder="Ask about the Smiths' health records…"
			offline={offline}
			agent={agent}
			family={family}
		/>
	);
}

const renderComposer = ({
	target = ASK_AGENT,
	offline = false,
}: {
	target?: ChatTarget;
	offline?: boolean;
} = {}) => {
	const agent = {
		ask: mock(
			async (_question: string, _files: readonly QuestionAttachment[]) => true,
		),
		askVoice: mock(async (_audio: Blob): Promise<string | null> => null),
	};
	const family = {
		send: mock(async (_body: string): Promise<Outcome> => ({ kind: "sent" })),
		transcribe: mock(
			async (_audio: Blob): Promise<ApiResult<VoiceTranscript>> => ({
				kind: "ready",
				value: {
					text: "see you soon",
					languageCode: "en",
					languageProbability: 1,
				},
			}),
		),
	};
	const view = render(
		<Harness
			initial={target}
			offline={offline}
			agent={agent}
			family={family}
		/>,
	);
	return { view, agent, family };
};

const box = (view: RenderResult) =>
	view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

const type = (view: RenderResult, text: string) =>
	fireEvent.change(box(view), { target: { value: text } });

const send = (view: RenderResult) =>
	fireEvent.click(view.getByRole("button", { name: "Send" }));

const pick = (view: RenderResult, files: File[]) => {
	const picker = view.container.querySelector('input[type="file"]');
	if (!(picker instanceof HTMLInputElement)) throw new Error("no file picker");
	Object.defineProperty(picker, "files", { value: files, configurable: true });
	fireEvent.change(picker);
};

test("Send with an empty box asks for a question, or a message in family mode", async () => {
	const { view, agent, family } = renderComposer();
	send(view);
	expect((await view.findByRole("status")).textContent).toBe(
		"Write a question first.",
	);
	fireEvent.click(view.getByRole("checkbox", { name: "Family only" }));
	type(view, "   ");
	send(view);
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe("Write a message first."),
	);
	expect(agent.ask).not.toHaveBeenCalled();
	expect(family.send).not.toHaveBeenCalled();
});

test("the Family only toggle says where Send goes and turns off attachments", () => {
	const { view } = renderComposer();
	expect(view.getByText("To: family agent · Gemini")).toBeDefined();
	expect(box(view).placeholder).toBe("Ask about the Smiths' health records…");
	const attach = view.getByRole("button", { name: "Attach files" });
	expect((attach as HTMLButtonElement).disabled).toBe(false);

	fireEvent.click(view.getByRole("checkbox", { name: "Family only" }));
	expect(view.getByText("To: family, not Gemini")).toBeDefined();
	expect(box(view).placeholder).toBe("Write to the family…");
	expect((attach as HTMLButtonElement).disabled).toBe(true);
	expect(attach.title).toBe(FILES_TIP);

	fireEvent.click(view.getByRole("checkbox", { name: "Family only" }));
	expect(view.getByText("To: family agent · Gemini")).toBeDefined();
});

test("a question goes to the agent and the box clears once answered", async () => {
	const { view, agent } = renderComposer();
	type(view, "  How did she sleep?  ");
	send(view);
	await waitFor(() => expect(box(view).value).toBe(""));
	expect(agent.ask).toHaveBeenCalledWith("How did she sleep?", []);
});

test("Send is off while a question is in flight, and newer typing is kept", async () => {
	const { view, agent } = renderComposer();
	const answered = Promise.withResolvers<boolean>();
	agent.ask.mockImplementation(() => answered.promise);
	type(view, "First");
	send(view);
	const sendButton = view.getByRole("button", { name: "Send" });
	await waitFor(() =>
		expect((sendButton as HTMLButtonElement).disabled).toBe(true),
	);
	type(view, "First and more");
	answered.resolve(true);
	await waitFor(() =>
		expect((sendButton as HTMLButtonElement).disabled).toBe(false),
	);
	expect(box(view).value).toBe("First and more");
});

test("an unanswered question stays in the box", async () => {
	const { view, agent } = renderComposer();
	agent.ask.mockImplementation(async () => false);
	type(view, "Hello?");
	send(view);
	await waitFor(() => expect(agent.ask).toHaveBeenCalled());
	await waitFor(() =>
		expect(
			(view.getByRole("button", { name: "Send" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	expect(box(view).value).toBe("Hello?");
});

test("offline, Send is disabled", () => {
	const { view } = renderComposer({ offline: true });
	expect(
		(view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
	).toBe(true);
});

test("Attach files opens the file picker", () => {
	const { view } = renderComposer();
	const picker = view.container.querySelector('input[type="file"]');
	const opened = mock(() => {});
	picker?.addEventListener("click", opened);
	fireEvent.click(view.getByRole("button", { name: "Attach files" }));
	expect(opened).toHaveBeenCalledTimes(1);
});

test("picked files show in the tray; a file that cannot go shows why and stays after Send", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const { view, agent } = renderComposer();
	pick(view, [
		new File(["hello"], "note.txt", { type: "text/plain;charset=utf-8" }),
		new File(["gif"], "pic.gif", { type: "image/gif" }),
	]);
	const tray = within(view.getByRole("list", { name: "Attached files" }));
	expect(tray.getByText("2 files")).toBeDefined();
	expect(tray.getByText("5 B")).toBeDefined();
	expect(tray.getByText("Not sent: Type not supported")).toBeDefined();
	expect(errors).toHaveBeenCalledWith(
		"Attachment pic.gif rejected:",
		"Type not supported",
	);

	type(view, "What is in this note?");
	send(view);
	await waitFor(() => expect(tray.getByText("1 file")).toBeDefined());
	expect(agent.ask).toHaveBeenCalledWith("What is in this note?", [
		{ name: "note.txt", mimeType: "text/plain", data: btoa("hello") },
	]);
	expect(tray.getByText("pic.gif")).toBeDefined();
	expect(tray.queryByText("note.txt")).toBeNull();

	fireEvent.click(view.getByRole("button", { name: "Remove pic.gif" }));
	expect(view.queryByRole("list", { name: "Attached files" })).toBeNull();
	errors.mockRestore();
});

test("a file that cannot be read stops the question and keeps it in the tray", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const { view, agent } = renderComposer();
	const broken = new File(["x"], "gone.txt", { type: "text/plain" });
	broken.arrayBuffer = () => Promise.reject(new Error("file was moved"));
	pick(view, [broken]);
	type(view, "Read this");
	send(view);
	expect((await view.findByRole("status")).textContent).toBe(
		"Not sent: a file could not be read. Error: file was moved",
	);
	expect(agent.ask).not.toHaveBeenCalled();
	expect(view.getByText("gone.txt")).toBeDefined();
	expect(box(view).value).toBe("Read this");
	errors.mockRestore();
});

test("a reply shows who it answers; Cancel and Escape end it", () => {
	const { view } = renderComposer({
		target: { familyOnly: false, replyTo: "Member abcdef" },
	});
	expect(view.getByText("Reply to Member abcdef")).toBeDefined();
	expect(view.getByText("To: family, not Gemini")).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "Cancel reply" }));
	expect(view.queryByText("Reply to Member abcdef")).toBeNull();
	expect(view.getByText("To: family agent · Gemini")).toBeDefined();
	fireEvent.keyDown(box(view), { key: "Escape" });
	expect(view.getByText("To: family agent · Gemini")).toBeDefined();
});

test("Escape ends a reply but keeps Family only on", () => {
	const { view } = renderComposer({
		target: { familyOnly: true, replyTo: "Member abcdef" },
	});
	fireEvent.keyDown(box(view), { key: "Enter" });
	expect(view.getByText("Reply to Member abcdef")).toBeDefined();
	fireEvent.keyDown(box(view), { key: "Escape" });
	expect(view.queryByText("Reply to Member abcdef")).toBeNull();
	expect(view.getByText("To: family, not Gemini")).toBeDefined();
});

test("a reply is sent to the family, then the box clears and the reply ends", async () => {
	const { view, agent, family } = renderComposer({
		target: { familyOnly: false, replyTo: "Member abcdef" },
	});
	type(view, "On my way");
	send(view);
	await waitFor(() => expect(box(view).value).toBe(""));
	expect(family.send).toHaveBeenCalledWith("On my way");
	expect(agent.ask).not.toHaveBeenCalled();
	expect(view.queryByText("Reply to Member abcdef")).toBeNull();
	expect(view.queryByRole("status")).toBeNull();
});

test("a family message saved for later says so and clears the box", async () => {
	const { view, family } = renderComposer({
		target: { familyOnly: true, replyTo: null },
	});
	family.send.mockImplementation(async () => ({ kind: "waiting" }));
	type(view, "Call me");
	send(view);
	expect((await view.findByRole("status")).textContent).toBe(
		"Saved on this device. It will be sent once, when the connection returns.",
	);
	expect(box(view).value).toBe("");
});

test("a refused family message shows the reason and stays in the box", async () => {
	const { view, family } = renderComposer({
		target: { familyOnly: false, replyTo: "Member abcdef" },
	});
	family.send.mockImplementation(async () => ({
		kind: "rejected",
		message: "Too long",
	}));
	type(view, "Long text");
	send(view);
	expect((await view.findByRole("status")).textContent).toBe(
		"Not sent: Too long",
	);
	expect(box(view).value).toBe("Long text");
	expect(view.getByText("Reply to Member abcdef")).toBeDefined();
});

// Voice: Happy DOM has no microphone, so the tests stand in a fake stream and recorder.

const realRecorder = globalThis.MediaRecorder;
const realDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
let recorded: Blob[] = [];
let recorderType = "";
const track = { stop: mock(() => {}) };

class FakeRecorder {
	mimeType = recorderType;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	start() {}
	stop() {
		for (const data of recorded) this.ondataavailable?.({ data });
		this.onstop?.();
	}
}

const microphone = (getUserMedia: () => Promise<unknown>) => {
	globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getUserMedia },
		configurable: true,
	});
};

afterEach(() => {
	globalThis.MediaRecorder = realRecorder;
	if (realDevices === undefined)
		Reflect.deleteProperty(navigator, "mediaDevices");
	else Object.defineProperty(navigator, "mediaDevices", realDevices);
	recorded = [];
	recorderType = "";
	track.stop.mockClear();
});

const record = async (view: RenderResult) => {
	fireEvent.click(view.getByRole("button", { name: "Voice" }));
	const stop = await view.findByRole("button", { name: "Stop recording" });
	expect(stop.getAttribute("aria-pressed")).toBe("true");
	expect(view.getByText("Recording…")).toBeDefined();
	fireEvent.click(stop);
};

test("a recording asks the agent, shows Working, then the agent's message", async () => {
	microphone(async () => ({ getTracks: () => [track] }));
	recorded = [new Blob(["voice"])];
	recorderType = "audio/ogg";
	const { view, agent } = renderComposer();
	const spoken = Promise.withResolvers<string | null>();
	agent.askVoice.mockImplementation(() => spoken.promise);

	send(view);
	await view.findByRole("status");
	await record(view);
	expect(view.queryByRole("status")).toBeNull();
	expect(await view.findByText("Working…")).toBeDefined();
	expect(
		(view.getByRole("button", { name: "Voice" }) as HTMLButtonElement).disabled,
	).toBe(true);
	expect(track.stop).toHaveBeenCalledTimes(1);
	expect(agent.askVoice.mock.calls[0]?.[0].type).toBe("audio/ogg");

	spoken.resolve("No spoken answer: no provider");
	expect((await view.findByRole("status")).textContent).toBe(
		"No spoken answer: no provider",
	);
	expect(view.queryByText("Working…")).toBeNull();
});

test("an empty recording sends nothing and the mic is ready again", async () => {
	microphone(async () => ({ getTracks: () => [track] }));
	const { view, agent } = renderComposer();
	await record(view);
	expect(await view.findByRole("button", { name: "Voice" })).toBeDefined();
	expect(agent.askVoice).not.toHaveBeenCalled();
	expect(track.stop).toHaveBeenCalledTimes(1);
});

test("without a microphone the composer says voice is not available", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	microphone(() => Promise.reject(new Error("denied")));
	const { view } = renderComposer();
	fireEvent.click(view.getByRole("button", { name: "Voice" }));
	expect((await view.findByRole("status")).textContent).toBe(
		"Voice not available: the microphone could not start.",
	);
	expect(view.getByRole("button", { name: "Voice" })).toBeDefined();
	errors.mockRestore();
});

test("in family mode a recording adds its words to the box, not to Gemini", async () => {
	microphone(async () => ({ getTracks: () => [track] }));
	recorded = [new Blob(["voice"])];
	const { view, agent, family } = renderComposer({
		target: { familyOnly: true, replyTo: null },
	});
	type(view, "Hi  ");
	await record(view);
	await waitFor(() => expect(box(view).value).toBe("Hi see you soon"));
	expect(family.transcribe.mock.calls[0]?.[0].type).toBe("audio/webm");
	expect(agent.askVoice).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(box(view));

	type(view, "");
	await record(view);
	await waitFor(() => expect(box(view).value).toBe("see you soon"));
});

test("in family mode silence or a failed transcription says so and keeps the box", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	microphone(async () => ({ getTracks: () => [track] }));
	recorded = [new Blob(["voice"])];
	const { view, family } = renderComposer({
		target: { familyOnly: true, replyTo: null },
	});
	family.transcribe.mockImplementation(async () => ({
		kind: "ready",
		value: { text: "  ", languageCode: "en", languageProbability: 1 },
	}));
	type(view, "Hi");
	await record(view);
	expect((await view.findByRole("status")).textContent).toBe(
		"No speech was heard.",
	);

	family.transcribe.mockImplementation(async () => ({ kind: "signed_out" }));
	await record(view);
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe(
			"Voice not transcribed: Sign in first.",
		),
	);
	expect(box(view).value).toBe("Hi");
	errors.mockRestore();
});
