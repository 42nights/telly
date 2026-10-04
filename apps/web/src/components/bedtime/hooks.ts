import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { Battery } from "./logic";

type BatteryManager = EventTarget & Battery;
type BatteryNavigator = Navigator & {
	getBattery?: () => Promise<BatteryManager>;
};

/** The phone's battery, or null while unknown: the Battery Status API is missing in Safari and Firefox. */
export function useBattery(): Battery | null {
	const [battery, setBattery] = useState<Battery | null>(null);
	useEffect(() => {
		const getBattery = (navigator as BatteryNavigator).getBattery;
		if (getBattery === undefined) return;
		let manager: BatteryManager | null = null;
		let stopped = false;
		const read = () =>
			manager !== null &&
			setBattery({ level: manager.level, charging: manager.charging });
		getBattery
			.call(navigator)
			.then((m) => {
				// Only a real BatteryManager reports changes; anything else stays unknown.
				if (stopped || !(m instanceof EventTarget)) return;
				manager = m;
				read();
				m.addEventListener("levelchange", read);
				m.addEventListener("chargingchange", read);
			})
			.catch(() => setBattery(null));
		return () => {
			stopped = true;
			manager?.removeEventListener("levelchange", read);
			manager?.removeEventListener("chargingchange", read);
			manager = null;
		};
	}, []);
	return battery;
}

const onOnlineChange = (notify: () => void) => {
	addEventListener("online", notify);
	addEventListener("offline", notify);
	return () => {
		removeEventListener("online", notify);
		removeEventListener("offline", notify);
	};
};

/** `navigator.onLine`: false proves no network; true only means some network is up. */
export const useOnline = () =>
	useSyncExternalStore(onOnlineChange, () => navigator.onLine);

type Noise = { readonly context: AudioContext; readonly gain: GainNode };

/** Ten seconds of brown noise, made on this device, so no audio file or license is needed. */
const startNoise = (volume: number): Noise => {
	const context = new AudioContext();
	const buffer = context.createBuffer(
		1,
		context.sampleRate * 10,
		context.sampleRate,
	);
	const data = buffer.getChannelData(0);
	let last = 0;
	for (let i = 0; i < data.length; i++) {
		last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
		data[i] = last * 3.5;
	}
	// End where the loop starts again, so the loop does not click.
	const drift = (data[data.length - 1] ?? 0) - (data[0] ?? 0);
	for (let i = 0; i < data.length; i++)
		data[i] = (data[i] ?? 0) - (drift * i) / (data.length - 1);
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	const gain = context.createGain();
	gain.gain.value = volume;
	source.connect(gain).connect(context.destination);
	source.start();
	return { context, gain };
};

/**
 * An optional sleep sound with volume and a sleep timer. `pause` also cancels the timer; call it
 * whenever the wearer asks for help or an important prompt needs to be heard.
 */
export function useSleepSound() {
	const audio = useRef<Noise | null>(null);
	const [playing, setPlaying] = useState(false);
	const [volume, setVolumeState] = useState(0.3);
	const [endsAt, setEndsAt] = useState<number | null>(null);

	const pause = useCallback(() => {
		void audio.current?.context.suspend();
		setPlaying(false);
		setEndsAt(null);
	}, []);

	/** Plays (or keeps playing) and restarts the sleep timer; null minutes plays until paused. */
	const play = (minutes: number | null) => {
		audio.current ??= startNoise(volume);
		void audio.current.context.resume();
		setPlaying(true);
		setEndsAt(minutes === null ? null : Date.now() + minutes * 60_000);
	};

	const setVolume = (value: number) => {
		setVolumeState(value);
		if (audio.current !== null) audio.current.gain.gain.value = value;
	};

	useEffect(() => {
		if (endsAt === null) return;
		const timer = setTimeout(pause, endsAt - Date.now());
		return () => clearTimeout(timer);
	}, [endsAt, pause]);
	useEffect(() => () => void audio.current?.context.close(), []);

	return { playing, volume, endsAt, play, pause, setVolume };
}

/**
 * A three-tone chime for a due reminder. `allowed` is false while the browser blocks sound; one tap
 * or key press on the page allows it.
 */
export function useChime() {
	const context = useRef<AudioContext | null>(null);
	const [allowed, setAllowed] = useState(false);
	useEffect(() => {
		const c = new AudioContext();
		context.current = c;
		const update = () => setAllowed(c.state === "running");
		const unlock = () => void c.resume();
		c.addEventListener("statechange", update);
		addEventListener("pointerdown", unlock);
		addEventListener("keydown", unlock);
		update();
		return () => {
			removeEventListener("pointerdown", unlock);
			removeEventListener("keydown", unlock);
			context.current = null;
			void c.close();
		};
	}, []);
	const chime = useCallback(() => {
		const c = context.current;
		if (c === null) return;
		try {
			[660, 880, 660].forEach((hz, i) => {
				const start = c.currentTime + i * 0.4;
				const tone = c.createOscillator();
				const gain = c.createGain();
				tone.frequency.value = hz;
				gain.gain.setValueAtTime(0.4, start);
				gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
				tone.connect(gain).connect(c.destination);
				tone.start(start);
				tone.stop(start + 0.35);
			});
		} catch {
			// A browser without full Web Audio stays silent; the prompt must still show.
			setAllowed(false);
		}
	}, []);
	return { allowed, chime };
}
