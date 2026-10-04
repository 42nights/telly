// Test-only stand-ins for `Audio` and blob URLs, which happy-dom cannot play or make.
import { afterEach, beforeEach } from "bun:test";

/** Stands in for `Audio`: records what was played, and how fast. */
export class FakeAudio {
	static made: FakeAudio[] = [];
	static play: () => Promise<void> = () => Promise.resolve();
	defaultPlaybackRate = 1;
	playbackRate = 1;
	paused = false;
	onended: (() => void) | null = null;
	constructor(readonly src: string) {
		FakeAudio.made.push(this);
	}
	play() {
		return FakeAudio.play();
	}
	pause() {
		this.paused = true;
	}
}

/**
 * Installs `FakeAudio` and numbered `blob:` URLs before each test, and restores the real ones
 * after. Returns the URLs made and revoked, in order.
 */
export function installFakeAudio() {
	const urls = { made: [] as string[], revoked: [] as string[] };
	let saved: { audio: unknown; create: unknown; revoke: unknown };
	beforeEach(() => {
		saved = {
			audio: Reflect.get(globalThis, "Audio"),
			create: URL.createObjectURL,
			revoke: URL.revokeObjectURL,
		};
		FakeAudio.made = [];
		FakeAudio.play = () => Promise.resolve();
		urls.made = [];
		urls.revoked = [];
		Object.assign(globalThis, { Audio: FakeAudio });
		Object.assign(URL, {
			createObjectURL: () => {
				urls.made.push(`blob:${urls.made.length + 1}`);
				return `blob:${urls.made.length}`;
			},
			revokeObjectURL: (url: string) => urls.revoked.push(url),
		});
	});
	afterEach(() => {
		Object.assign(globalThis, { Audio: saved.audio });
		Object.assign(URL, {
			createObjectURL: saved.create,
			revokeObjectURL: saved.revoke,
		});
	});
	return urls;
}
