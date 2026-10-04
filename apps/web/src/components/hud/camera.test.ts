import { describe, expect, test } from "bun:test";
import { type CameraState, openCamera } from "./camera";

class FakeTrack extends EventTarget {
	stopped = false;
	stop() {
		this.stopped = true;
	}
}

const fakeCamera = (outcome: "grant" | DOMException) => {
	const tracks = [new FakeTrack(), new FakeTrack()];
	const stream = { getTracks: () => tracks } as unknown as MediaStream;
	let settle = () => {};
	const media = {
		getUserMedia: () =>
			new Promise<MediaStream>((resolve, reject) => {
				settle = () =>
					outcome === "grant" ? resolve(stream) : reject(outcome);
			}),
	};
	const states: CameraState[] = [];
	const stop = openCamera(media, (state) => states.push(state));
	const kinds = () => states.map((state) => state.kind);
	return { tracks, stop, states, kinds, settle: async () => settle() };
};

describe("camera lifecycle", () => {
	test("stop releases every track of a live camera", async () => {
		const camera = fakeCamera("grant");
		await camera.settle();
		expect(camera.kinds()).toEqual(["starting", "live"]);
		camera.stop();
		expect(camera.tracks.every((track) => track.stopped)).toBe(true);
	});

	test("a grant that arrives after stop is released and never shown", async () => {
		const camera = fakeCamera("grant");
		camera.stop();
		await camera.settle();
		expect(camera.kinds()).toEqual(["starting"]);
		expect(camera.tracks.every((track) => track.stopped)).toBe(true);
	});

	test("lost capture stops the other tracks and reports lost", async () => {
		const camera = fakeCamera("grant");
		await camera.settle();
		camera.tracks[0]?.dispatchEvent(new Event("ended"));
		expect(camera.kinds()).toEqual(["starting", "live", "lost"]);
		expect(camera.tracks.every((track) => track.stopped)).toBe(true);
	});

	test("permission denied and missing camera are distinct failures", async () => {
		const denied = fakeCamera(new DOMException("no", "NotAllowedError"));
		const missing = fakeCamera(new DOMException("no", "NotFoundError"));
		await denied.settle();
		await missing.settle();
		expect(denied.states.at(-1)).toMatchObject({ reason: "denied" });
		expect(missing.states.at(-1)).toMatchObject({ reason: "no-camera" });
	});

	test("an insecure page without mediaDevices fails without prompting", () => {
		const states: CameraState[] = [];
		openCamera(undefined, (state) => states.push(state));
		expect(states).toMatchObject([{ kind: "failed", reason: "unsupported" }]);
	});
});
