// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, renderHook, setupDom, waitFor } from "../test/dom";
import { useBattery, useChime, useOnline, useSleepSound } from "./hooks";

setupDom();

/** A Web Audio stand-in: records what was played, so a test can hear it. */
class FakeAudioContext extends EventTarget {
	static made: FakeAudioContext[] = [];
	static failTones = false;
	state: AudioContextState = "suspended";
	readonly sampleRate = 50;
	readonly currentTime = 2;
	readonly destination = {};
	readonly buffers: Float32Array[] = [];
	readonly gains: { gain: { value: number } }[] = [];
	readonly tones: { hz: number; start: number; stop: number }[] = [];
	looping = false;
	closed = false;
	constructor() {
		super();
		FakeAudioContext.made.push(this);
	}
	createBuffer(_channels: number, length: number) {
		const data = new Float32Array(length);
		this.buffers.push(data);
		return { getChannelData: () => data };
	}
	createBufferSource() {
		return {
			buffer: null as unknown,
			loop: false,
			connect: (node: unknown) => node,
			start: () => {
				this.looping = true;
			},
		};
	}
	createGain() {
		const gain = {
			gain: {
				value: 1,
				setValueAtTime: () => {},
				exponentialRampToValueAtTime: () => {},
			},
			connect: (node: unknown) => node,
		};
		this.gains.push(gain);
		return gain;
	}
	createOscillator() {
		if (FakeAudioContext.failTones) throw new Error("no oscillator");
		const tone = { hz: 0, start: 0, stop: 0 };
		this.tones.push(tone);
		return {
			frequency: {
				set value(hz: number) {
					tone.hz = hz;
				},
			},
			connect: (node: unknown) => node,
			start: (at: number) => {
				tone.start = at;
			},
			stop: (at: number) => {
				tone.stop = at;
			},
		};
	}
	private set(state: AudioContextState) {
		this.state = state;
		this.dispatchEvent(new Event("statechange"));
	}
	async resume() {
		this.set("running");
	}
	async suspend() {
		this.set("suspended");
	}
	async close() {
		this.closed = true;
		this.set("closed");
	}
}

const realAudio = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
beforeEach(() => {
	FakeAudioContext.made = [];
	FakeAudioContext.failTones = false;
	Object.defineProperty(globalThis, "AudioContext", {
		configurable: true,
		writable: true,
		value: FakeAudioContext,
	});
});
afterEach(() => {
	if (realAudio === undefined)
		Reflect.deleteProperty(globalThis, "AudioContext");
	else Object.defineProperty(globalThis, "AudioContext", realAudio);
});

const lastContext = () => {
	const context = FakeAudioContext.made.at(-1);
	if (context === undefined) throw new Error("no audio context");
	return context;
};

describe("useBattery", () => {
	const nav = navigator as Navigator & { getBattery?: unknown };
	afterEach(() => {
		Reflect.deleteProperty(nav, "getBattery");
	});
	const stub = (getBattery: () => Promise<unknown>) =>
		Object.defineProperty(nav, "getBattery", {
			configurable: true,
			value: getBattery,
		});

	test("a browser without the Battery Status API reports an unknown charge", () => {
		const { result } = renderHook(() => useBattery());
		expect(result.current).toBeNull();
	});

	test("reports the charge and follows level and charging changes until unmounted", async () => {
		const manager = Object.assign(new EventTarget(), {
			level: 0.42,
			charging: false,
		});
		stub(async () => manager);
		const { result, unmount } = renderHook(() => useBattery());
		await waitFor(() =>
			expect(result.current).toEqual({ level: 0.42, charging: false }),
		);
		manager.charging = true;
		act(() => {
			manager.dispatchEvent(new Event("chargingchange"));
		});
		expect(result.current).toEqual({ level: 0.42, charging: true });
		manager.level = 0.5;
		act(() => {
			manager.dispatchEvent(new Event("levelchange"));
		});
		expect(result.current).toEqual({ level: 0.5, charging: true });
		unmount();
		manager.level = 0.9;
		manager.dispatchEvent(new Event("levelchange"));
		expect(result.current).toEqual({ level: 0.5, charging: true });
	});

	test("a reply that is not a battery manager, or a refusal, stays unknown", async () => {
		let answered = false;
		stub(async () => {
			answered = true;
			return { level: 1, charging: true };
		});
		const fake = renderHook(() => useBattery());
		await waitFor(() => expect(answered).toBe(true));
		await act(async () => {});
		expect(fake.result.current).toBeNull();
		fake.unmount();

		let refused = false;
		stub(async () => {
			refused = true;
			throw new Error("blocked");
		});
		const blocked = renderHook(() => useBattery());
		await waitFor(() => expect(refused).toBe(true));
		await act(async () => {});
		expect(blocked.result.current).toBeNull();
	});

	test("a battery that answers after the screen closed is ignored", async () => {
		const { promise, resolve } = Promise.withResolvers<EventTarget>();
		stub(() => promise);
		const manager = Object.assign(new EventTarget(), {
			level: 1,
			charging: true,
		});
		const { result, unmount } = renderHook(() => useBattery());
		unmount();
		await act(async () => resolve(manager));
		expect(result.current).toBeNull();
	});
});

describe("useOnline", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "onLine");
	});

	test("follows the browser going offline and online again", () => {
		let online = true;
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => online,
		});
		const { result, unmount } = renderHook(() => useOnline());
		expect(result.current).toBe(true);
		online = false;
		act(() => {
			dispatchEvent(new Event("offline"));
		});
		expect(result.current).toBe(false);
		online = true;
		act(() => {
			dispatchEvent(new Event("online"));
		});
		expect(result.current).toBe(true);
		unmount();
	});
});

describe("useSleepSound", () => {
	test("plays a seamless noise loop at the chosen volume, and pause stops it", async () => {
		const { result } = renderHook(() => useSleepSound());
		expect(result.current.playing).toBe(false);
		expect(FakeAudioContext.made).toHaveLength(0);

		act(() => result.current.setVolume(0.6));
		expect(result.current.volume).toBe(0.6);
		act(() => result.current.play(null));
		const context = lastContext();
		await waitFor(() => expect(context.state).toBe("running"));
		expect(result.current.playing).toBe(true);
		expect(result.current.endsAt).toBeNull();
		expect(context.looping).toBe(true);
		expect(context.gains[0]?.gain.value).toBe(0.6);
		// The loop ends where it starts, so it does not click.
		const data = context.buffers[0];
		expect(data).toHaveLength(500);
		expect(data?.at(-1)).toBeCloseTo(data?.[0] ?? Number.NaN, 6);
		expect(data?.some((sample) => sample !== 0)).toBe(true);

		act(() => result.current.setVolume(0.1));
		expect(context.gains[0]?.gain.value).toBe(0.1);

		act(() => result.current.pause());
		await waitFor(() => expect(context.state).toBe("suspended"));
		expect(result.current.playing).toBe(false);
	});

	test("the sleep timer pauses the sound, and playing again reuses the same sound", async () => {
		const { result, unmount } = renderHook(() => useSleepSound());
		const before = Date.now();
		act(() => result.current.play(30));
		expect(result.current.endsAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
		// A very short timer: 30 ms.
		act(() => result.current.play(0.0005));
		expect(FakeAudioContext.made).toHaveLength(1);
		await waitFor(() => expect(result.current.playing).toBe(false));
		expect(result.current.endsAt).toBeNull();
		expect(lastContext().state).toBe("suspended");
		unmount();
		expect(lastContext().closed).toBe(true);
	});
});

describe("useChime", () => {
	test("stays blocked until a tap or key press allows sound", async () => {
		const { result, unmount } = renderHook(() => useChime());
		expect(result.current.allowed).toBe(false);
		await act(async () => {
			dispatchEvent(new Event("pointerdown"));
		});
		expect(result.current.allowed).toBe(true);
		unmount();
		expect(lastContext().closed).toBe(true);
	});

	test("a key press also allows sound, and the chime plays three tones", async () => {
		const { result } = renderHook(() => useChime());
		await act(async () => {
			dispatchEvent(new Event("keydown"));
		});
		expect(result.current.allowed).toBe(true);
		act(() => result.current.chime());
		expect(lastContext().tones).toEqual([
			{ hz: 660, start: 2, stop: 2.35 },
			{ hz: 880, start: 2.4, stop: 2.75 },
			{ hz: 660, start: 2.8, stop: 3.15 },
		]);
	});

	test("without full Web Audio the chime stays silent and reports sound as blocked", async () => {
		FakeAudioContext.failTones = true;
		const { result } = renderHook(() => useChime());
		await act(async () => {
			dispatchEvent(new Event("pointerdown"));
		});
		expect(result.current.allowed).toBe(true);
		act(() => result.current.chime());
		expect(result.current.allowed).toBe(false);
		expect(lastContext().tones).toHaveLength(0);
	});

	test("a chime after the screen closed plays nothing", () => {
		const { result, unmount } = renderHook(() => useChime());
		const { chime } = result.current;
		const context = lastContext();
		unmount();
		chime();
		expect(context.tones).toHaveLength(0);
	});
});
