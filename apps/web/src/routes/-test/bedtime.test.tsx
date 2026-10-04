import { beforeEach, expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load,
// or React never listens for `input` events.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

// happy-dom has no Web Audio. This fake records what the page asks of it.
const audio = { resumed: 0, suspended: 0, tones: 0, gain: 0 };
class FakeAudioContext extends EventTarget {
	state = "running";
	sampleRate = 10;
	currentTime = 0;
	destination = {};
	resume = async () => void audio.resumed++;
	suspend = async () => void audio.suspended++;
	close = async () => {};
	createBuffer = (_c: number, length: number) => {
		const data = new Float32Array(length);
		return { getChannelData: () => data };
	};
	createBufferSource = () => ({
		buffer: null,
		loop: false,
		connect: (next: unknown) => next,
		start: () => {},
	});
	createGain = () => {
		const node = {
			gain: {
				set value(v: number) {
					audio.gain = v;
				},
				setValueAtTime: () => {},
				exponentialRampToValueAtTime: () => {},
			},
			connect: (next: unknown) => next,
		};
		return node;
	};
	createOscillator = () => {
		audio.tones++;
		return {
			frequency: { value: 0 },
			connect: (next: unknown) => next,
			start: () => {},
			stop: () => {},
		};
	};
}
Object.assign(globalThis, { AudioContext: FakeAudioContext });

beforeEach(() => {
	Object.assign(audio, { resumed: 0, suspended: 0, tones: 0, gain: 0 });
});

const occurrence = {
	id: "7",
	reminderId: "3",
	familyId: "1",
	kind: "medication",
	subjectId: null,
	title: "Evening pills",
	scheduledFor: "2026-10-04T20:00:00Z",
	state: "scheduled",
	promptDue: true,
	prompts: 1,
	nextPromptAt: null,
};

const base = {
	"GET /api/families": { families: [FAMILY] },
	"GET /health": { status: "ok", service: "server" },
	"GET /api/families/fam-1/reminder-occurrences": { occurrences: [] },
	"GET /api/families/fam-1/reminder-settings": json(503, {
		error: "unavailable",
		message: "down",
	}),
};

const speakerOn = {
	"GET /api/families/fam-1/speaker-settings": {
		settings: { enabled: true, room: "shared", sharedRoomKinds: [] },
		updatedBy: null,
		updatedAt: null,
	},
	"GET /api/families/fam-1/speaker": {
		provider: "simulated",
		mode: "online",
		announcements: [],
	},
};

test("lists what works tonight and what does not", async () => {
	signIn();
	serve({ ...base, ...speakerOn });
	renderRoute("/bedtime");

	expect(await screen.findByText("Reminder sound on.")).toBeTruthy();
	expect(await screen.findByText("Connected to the server.")).toBeTruthy();
	expect(await screen.findByText(/Home speaker on \(simulated/)).toBeTruthy();
	expect(screen.getByText(/Charge unknown/)).toBeTruthy();
	expect(screen.getByText(/WHOOP buzz off/)).toBeTruthy();
});

test("shows the speaker as unknown and the server as silent when they fail", async () => {
	signIn();
	serve({
		...base,
		"GET /health": () => {
			throw new TypeError("Failed to fetch");
		},
	});
	renderRoute("/bedtime");

	expect(
		await screen.findByText(
			"Home speaker unknown · prompts show on this phone.",
		),
	).toBeTruthy();
	expect(
		screen.getByText("Network on, but the server does not answer."),
	).toBeTruthy();
});

test("signed out, no family is loaded and nothing is fetched for it", async () => {
	const calls = serve(base);
	renderRoute("/bedtime");

	expect(
		await screen.findByText(
			"Home speaker unknown · prompts show on this phone.",
		),
	).toBeTruthy();
	expect(calls.some((c) => c.path.startsWith("/api/families/"))).toBe(false);
});

test("plays, changes volume and timer, and pauses the sleep sound", async () => {
	signIn();
	serve({ ...base, ...speakerOn });
	renderRoute("/bedtime");

	expect(await screen.findByText("Sound is off.")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Play sound" }));
	expect(await screen.findByText(/^Stops in (30:00|29:5\d)\.$/)).toBeTruthy();
	expect(audio.resumed).toBeGreaterThan(0);

	fireEvent.input(screen.getByRole("slider", { name: "Volume" }), {
		target: { value: "0.5" },
	});
	expect(audio.gain).toBe(0.5);

	const timer = screen.getByRole("combobox", { name: "Sleep timer" });
	fireEvent.change(timer, { target: { value: "off" } });
	expect(await screen.findByText("Playing until you pause it.")).toBeTruthy();
	fireEvent.change(timer, { target: { value: "15" } });
	expect(await screen.findByText(/^Stops in (15:00|14:5\d)\.$/)).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Pause sound" }));
	expect(await screen.findByText("Sound is off.")).toBeTruthy();
	expect(audio.suspended).toBeGreaterThan(0);

	// Changing the timer while off does not start the sound.
	fireEvent.change(timer, { target: { value: "60" } });
	expect(screen.getByText("Sound is off.")).toBeTruthy();
});

test("asking for help pauses the sleep sound", async () => {
	signIn();
	serve({ ...base, ...speakerOn });
	renderRoute("/bedtime");

	fireEvent.click(await screen.findByRole("button", { name: "Play sound" }));
	expect(await screen.findByText(/^Stops in/)).toBeTruthy();
	const help = screen.getByRole("region", { name: "Ask for help" });
	fireEvent.pointerDown(help);
	expect(await screen.findByText("Sound is off.")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Play sound" }));
	expect(await screen.findByText(/^Stops in/)).toBeTruthy();
	fireEvent.keyDown(help, { key: "a" });
	expect(await screen.findByText("Sound is off.")).toBeTruthy();
});

test("a due prompt chimes and records the phone delivery when the speaker cannot say it", async () => {
	signIn();
	let due = true;
	const calls = serve({
		...base,
		...speakerOn,
		"GET /api/families/fam-1/reminder-occurrences": () => ({
			occurrences: [
				{ occurrence: { ...occurrence, promptDue: due }, events: [] },
			],
		}),
		"POST /api/families/fam-1/reminder-occurrences/7/speaker-handoffs": {
			outcome: "use_phone",
			reason: "offline",
		},
		"POST /api/families/fam-1/reminder-occurrences/7/deliveries": () => {
			due = false;
			return {
				occurrence: { ...occurrence, promptDue: false, state: "delivered" },
				events: [],
			};
		},
	});
	renderRoute("/bedtime");

	await waitFor(() =>
		expect(calls.find((c) => c.path.endsWith("/deliveries"))?.body).toEqual({
			clientId: "bedtime-7-1",
			source: "web",
		}),
	);
	const handoff = calls.find((c) => c.path.endsWith("/speaker-handoffs"));
	expect(handoff?.method).toBe("POST");
	expect(handoff?.body).toEqual({ clientId: "bedtime-7-1" });
	// Three tones of the chime.
	expect(audio.tones).toBe(3);
});
