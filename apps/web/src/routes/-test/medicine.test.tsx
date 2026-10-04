import { expect, test } from "bun:test";
import type { Call } from "@/lib/test/app";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const DETECT = "POST /api/families/fam-1/vision/medicine-detections";

// A fake camera: one stream, frames painted at once, and a canvas that encodes a tiny JPEG.
// The motion sampler asks for a readable context; none is given, so markers clear only by age.
function installCamera() {
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			getUserMedia: async () =>
				Object.assign(new MediaStream(), { getTracks: () => [] }),
		},
	});
	const video = HTMLVideoElement.prototype as unknown as Record<
		string,
		unknown
	>;
	video.requestVideoFrameCallback = (callback: () => void) => callback();
	for (const [key, value] of [
		["videoWidth", 640],
		["videoHeight", 480],
	] as const)
		Object.defineProperty(HTMLVideoElement.prototype, key, {
			configurable: true,
			get: () => value,
		});
	const canvas = HTMLCanvasElement.prototype as unknown as Record<
		string,
		unknown
	>;
	canvas.getContext = (_: string, options?: object) =>
		options === undefined ? { drawImage: () => {} } : null;
	canvas.toDataURL = () => "data:image/jpeg;base64,AAAA";
}

const detections =
	(found: object[]) =>
	({ body }: Call) => ({
		// The reply names the frame that was sent.
		frame:
			body !== null && typeof body === "object" && "frame" in body
				? body.frame
				: null,
		detections: found,
		model: "vision-model",
		analyzedAt: "2026-10-01T12:00:00.000Z",
	});

const ASPIRIN = {
	label: "Aspirin",
	confidence: 0.9,
	needsVerification: false,
	box: { x: 100, y: 100, width: 80, height: 120 },
};

async function showVideo() {
	fireEvent.loadedData(await screen.findByLabelText("Live camera preview"));
}

test("looks for the asked medicine once the video shows, marks it, and looks again on request", async () => {
	installCamera();
	signIn();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1/medicine-memory": {
			permission: {
				places: ["Kitchen"],
				setBy: "user-1",
				setAt: "2026-10-01T00:00:00.000Z",
			},
			sightings: [],
		},
		[DETECT]: detections([
			{ ...ASPIRIN, label: "Vitamin D", confidence: 0.6 },
			ASPIRIN,
		]),
	});
	renderRoute("/medicine?q=aspirin");

	expect(await screen.findByText("“aspirin”")).toBeTruthy();
	expect(screen.getByText("You asked")).toBeTruthy();
	await showVideo();

	expect(await screen.findByText("I found it")).toBeTruthy();
	expect(screen.getByAltText("Camera frame that was checked")).toBeTruthy();
	expect(
		await screen.findByRole("form", { name: "Remember where it is" }),
	).toBeTruthy();
	const sent = calls.filter((c) => `${c.method} ${c.path}` === DETECT);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.body).toMatchObject({
		frame: { width: 640, height: 480, rotation: 0 },
		image: { type: "image/jpeg", data: "AAAA" },
	});

	fireEvent.click(screen.getByRole("button", { name: "Look again" }));
	await waitFor(() =>
		expect(
			calls.filter((c) => `${c.method} ${c.path}` === DETECT),
		).toHaveLength(2),
	);
});

test("says nothing was found when the picture has no medicine container", async () => {
	installCamera();
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		[DETECT]: detections([]),
	});
	renderRoute("/medicine");

	await showVideo();
	expect(
		await screen.findByText(
			"None found in this picture. Point the phone at the counter or shelf and try again.",
		),
	).toBeTruthy();
	expect(screen.queryByText("You asked")).toBeNull();
	expect(
		screen.queryByRole("form", { name: "Remember where it is" }),
	).toBeNull();
});

test("explains that a caller who is not a member cannot check pictures", async () => {
	installCamera();
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		[DETECT]: json(403, {
			error: "forbidden",
			message: "Not a member of this family.",
		}),
	});
	renderRoute("/medicine?q=pills");

	await showVideo();
	expect(
		await screen.findByText("I can't check the picture right now."),
	).toBeTruthy();
	expect(screen.getByText(/Not a member of this family\./)).toBeTruthy();
});
