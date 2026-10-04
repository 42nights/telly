// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { afterEach, beforeEach, expect, jest, test } from "bun:test";

import { act, fireEvent, render, setupDom } from "../test/dom-routed";
import { CameraPreview, useCamera } from "./camera-preview";

setupDom();

class FakeTrack extends EventTarget {
	stopped = false;
	stop() {
		this.stopped = true;
	}
}

/** A camera whose permission prompt the test answers with `grant` or `deny`. */
const stubCamera = () => {
	const tracks = [new FakeTrack()];
	// Happy DOM's video accepts only a MediaStream as `srcObject`.
	const stream: MediaStream = Object.assign(
		Object.create(MediaStream.prototype),
		{ getTracks: () => tracks },
	);
	const requests: MediaStreamConstraints[] = [];
	let answer: { grant: () => void; deny: (error: Error) => void } | undefined;
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			getUserMedia: (constraints: MediaStreamConstraints) => {
				requests.push(constraints);
				return new Promise<MediaStream>((resolve, reject) => {
					answer = { grant: () => resolve(stream), deny: reject };
				});
			},
		},
	});
	return {
		tracks,
		stream,
		requests,
		grant: () => act(async () => answer?.grant()),
		deny: (error: Error) => act(async () => answer?.deny(error)),
	};
};

const realMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const realPermissions = Object.getOwnPropertyDescriptor(
	navigator,
	"permissions",
);

/** What the browser says about the camera permission. */
const browserSays = (state: PermissionState) =>
	Object.defineProperty(navigator, "permissions", {
		configurable: true,
		value: { query: async () => ({ state }) },
	});

// Each test is a new device: the camera never ran here, and the browser has not been asked.
beforeEach(() => {
	localStorage.clear();
	browserSays("prompt");
});
afterEach(() => {
	jest.useRealTimers();
	if (realMedia) Object.defineProperty(navigator, "mediaDevices", realMedia);
	else Reflect.deleteProperty(navigator, "mediaDevices");
	if (realPermissions)
		Object.defineProperty(navigator, "permissions", realPermissions);
	else Reflect.deleteProperty(navigator, "permissions");
	Reflect.deleteProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
	);
});

/** The camera ran on this device before, so auto start opens it at once. */
const ranBefore = () => localStorage.setItem("telly.camera.allowed", "1");

function Scene({
	autoStart,
	onVideo,
}: {
	autoStart?: boolean;
	onVideo?: (video: HTMLVideoElement) => void;
}) {
	const camera = useCamera(autoStart);
	return (
		<CameraPreview camera={camera} {...(onVideo ? { onVideo } : {})}>
			<button type="button">Capture</button>
		</CameraPreview>
	);
}

test("turning the camera on asks for the rear camera, shows it live, and stop releases it", async () => {
	const camera = stubCamera();
	const frames: (() => void)[] = [];
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: (callback: () => void) => frames.push(callback),
		},
	);
	const captured: HTMLVideoElement[] = [];
	const view = render(<Scene onVideo={(video) => captured.push(video)} />);
	expect(view.getByText("Camera is off")).toBeDefined();
	expect(view.queryByRole("alert")).toBeNull();

	fireEvent.click(view.getByRole("button", { name: "Turn on camera" }));
	expect(view.getByText("Waiting for camera permission…")).toBeDefined();
	expect(view.queryByRole("button")).toBeNull();
	expect(camera.requests).toEqual([
		{ video: { facingMode: "environment" }, audio: false },
	]);

	await camera.grant();
	const video = view.getByLabelText("Live camera preview") as HTMLVideoElement;
	expect(video.srcObject).toBe(camera.stream);
	expect(view.getByRole("button", { name: "Capture" })).toBeDefined();

	// The capture waits for the first painted frame, not for `loadeddata`.
	fireEvent.loadedData(video);
	expect(captured).toEqual([]);
	frames[0]?.();
	expect(captured).toEqual([video]);

	fireEvent.click(view.getByRole("button", { name: "Stop camera" }));
	expect(camera.tracks.every((track) => track.stopped)).toBe(true);
	expect(view.getByText("Camera is off")).toBeDefined();
	expect(view.queryByLabelText("Live camera preview")).toBeNull();
});

test("a frame without an onVideo listener is ignored", async () => {
	const camera = stubCamera();
	let frame: (() => void) | undefined;
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: (callback: () => void) => {
				frame = callback;
			},
		},
	);
	ranBefore();
	const view = render(<Scene autoStart />);
	await camera.grant();
	fireEvent.loadedData(view.getByLabelText("Live camera preview"));
	expect(frame).toBeDefined();
	frame?.();
	expect(view.getByLabelText("Live camera preview")).toBeDefined();
});

test("auto start opens a camera that ran before, and a lost feed is announced with a retry", async () => {
	const camera = stubCamera();
	ranBefore();
	const view = render(<Scene autoStart />);
	expect(view.getByText("Waiting for camera permission…")).toBeDefined();
	await camera.grant();
	act(() => {
		camera.tracks[0]?.dispatchEvent(new Event("ended"));
	});
	expect(view.getByText("Camera stopped")).toBeDefined();
	expect(view.getByRole("alert").textContent).toContain(
		"The browser ended the camera feed.",
	);
	fireEvent.click(view.getByRole("button", { name: "Try again" }));
	expect(camera.requests).toHaveLength(2);
});

test("a first visit shows the start button and asks nothing; the next visit starts at once", async () => {
	const camera = stubCamera();
	const first = render(<Scene autoStart />);
	await act(async () => {});
	expect(first.getByText("Camera is off")).toBeDefined();
	expect(camera.requests).toHaveLength(0);
	fireEvent.click(first.getByRole("button", { name: "Turn on camera" }));
	await camera.grant();
	first.unmount();

	const next = render(<Scene autoStart />);
	expect(next.getByText("Waiting for camera permission…")).toBeDefined();
	expect(camera.requests).toHaveLength(2);
});

test("auto start opens the camera when the browser already allows it", async () => {
	const camera = stubCamera();
	browserSays("granted");
	const view = render(<Scene autoStart />);
	await act(async () => {});
	expect(view.getByText("Waiting for camera permission…")).toBeDefined();
	expect(camera.requests).toHaveLength(1);
});

test("a lost feed opens again by itself, a few times", async () => {
	jest.useFakeTimers();
	const camera = stubCamera();
	ranBefore();
	const view = render(<Scene autoStart />);
	await camera.grant();
	act(() => {
		camera.tracks[0]?.dispatchEvent(new Event("ended"));
	});
	expect(view.getByText("Camera stopped")).toBeDefined();
	act(() => jest.advanceTimersByTime(1_500));
	expect(camera.requests).toHaveLength(2);
	expect(view.getByText("Waiting for camera permission…")).toBeDefined();

	// A camera that keeps failing stops retrying, and Try again stays.
	for (let i = 0; i < 5; i++) {
		await camera.deny(new DOMException("busy", "NotReadableError"));
		act(() => jest.advanceTimersByTime(1_500));
	}
	expect(camera.requests).toHaveLength(4);
	expect(view.getByRole("button", { name: "Try again" })).toBeDefined();
});

test("coming back to the page opens a camera that ended while away", async () => {
	const camera = stubCamera();
	ranBefore();
	render(<Scene autoStart />);
	await camera.grant();
	// iPhone ends a backgrounded page's tracks without an `ended` event.
	Object.assign(camera.tracks[0] ?? {}, { readyState: "ended" });
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(camera.requests).toHaveLength(2);
});

test("a denied camera is not opened again by itself", async () => {
	jest.useFakeTimers();
	const camera = stubCamera();
	ranBefore();
	render(<Scene autoStart />);
	await camera.deny(new DOMException("no", "NotAllowedError"));
	act(() => jest.advanceTimersByTime(10_000));
	expect(camera.requests).toHaveLength(1);
	expect(localStorage.getItem("telly.camera.allowed")).toBeNull();
});

test("unmounting releases a live camera", async () => {
	const camera = stubCamera();
	ranBefore();
	const view = render(<Scene autoStart />);
	await camera.grant();
	view.unmount();
	expect(camera.tracks.every((track) => track.stopped)).toBe(true);
});

test.each([
	["NotAllowedError", "Camera permission denied", "browser settings"],
	["NotFoundError", "No camera found", "Connect a camera"],
	["NotReadableError", "Camera could not start", "Another app"],
	["TypeError", "Camera failed to start", "reload the page"],
])(
	"a %s failure is announced and Try again asks again",
	async (name, title, hint) => {
		const camera = stubCamera();
		ranBefore();
		const view = render(<Scene autoStart />);
		await camera.deny(new DOMException("no", name));
		expect(view.getByText(title)).toBeDefined();
		expect(view.getByRole("alert").textContent).toContain(hint);
		fireEvent.click(view.getByRole("button", { name: "Try again" }));
		expect(view.getByText("Waiting for camera permission…")).toBeDefined();
		expect(camera.requests).toHaveLength(2);
	},
);

test("without a secure context the camera is reported unavailable", () => {
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: undefined,
	});
	ranBefore();
	const view = render(<Scene autoStart />);
	expect(view.getByText("Camera unavailable in this browser")).toBeDefined();
	expect(view.getByRole("alert").textContent).toContain("HTTPS or localhost");
});
