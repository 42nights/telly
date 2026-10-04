import { expect, test } from "bun:test";
import type { Call } from "@/lib/test/app";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const DETECT = "POST /api/families/fam-1/vision/object-detections";

// A fake camera: one stream, frames painted at once, and a canvas that encodes a tiny JPEG.
// The tracker asks for a readable context; none is given, so the lock-on waits at "Locking on…".
function installCamera() {
	// The camera ran on this device before, so the finder opens it at once.
	localStorage.setItem("telly.camera.allowed", "1");
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

const PILLS = {
	category: "medicine",
	label: "Aspirin",
	confidence: 0.9,
	needsVerification: false,
	box: { x: 100, y: 100, width: 80, height: 120 },
};
const KEYS = { ...PILLS, category: "keys", label: "keys", confidence: 0.8 };

const MEMORY = "/api/families/fam-1/medicine-memory";
const memory = (sightings: object[]) => ({
	personId: "a".repeat(64),
	people: ["a".repeat(64)],
	places: ["Kitchen"],
	sightings,
});

/** The video shows, then the person taps Check: opening the finder takes no picture. */
async function showVideo() {
	fireEvent.loadedData(await screen.findByLabelText("Live camera preview"));
	fireEvent.click(
		await screen.findByRole("button", { name: "Check this picture" }),
	);
}

test("opening the finder shows the camera and sends nothing to vision until Check", async () => {
	installCamera();
	signIn();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		[`GET ${MEMORY}`]: memory([]),
		[DETECT]: detections([KEYS]),
	});
	renderRoute("/find?q=where%20are%20my%20keys");
	fireEvent.loadedData(await screen.findByLabelText("Live camera preview"));
	await screen.findByRole("button", { name: "Check this picture" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(calls.filter((c) => `${c.method} ${c.path}` === DETECT)).toEqual([]);
	expect(screen.queryByAltText("Camera frame that was checked")).toBeNull();
});

test("names the asked thing first, Not this moves on, and Save keeps it at the named place", async () => {
	installCamera();
	signIn();
	const saved = {
		id: "7",
		familyId: "fam-1",
		personId: "a".repeat(64),
		savedBy: "a".repeat(64),
		container: "Aspirin",
		place: "Hall",
		seenAt: new Date().toISOString(),
		source: "camera_check",
		confidence: 0.9,
		labelRead: true,
		category: "medicine",
		thumbnail: "",
		notFoundAt: null,
		usualPlace: null,
		pinned: false,
	};
	let stored: object[] = [];
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		[`GET ${MEMORY}`]: () => memory(stored),
		[`POST ${MEMORY}/sightings`]: () => {
			stored = [saved];
			return memory(stored);
		},
		[DETECT]: detections([PILLS, KEYS]),
	});
	// An old /medicine link still opens the finder, with its request.
	renderRoute("/medicine?q=where%20are%20my%20keys");

	expect(await screen.findByText("“where are my keys”")).toBeTruthy();
	expect(screen.getByRole("heading", { name: "Find things" })).toBeTruthy();
	await showVideo();

	// The asked kind leads, although the model put the pills first.
	expect((await screen.findByText(/Looks like:/)).textContent).toBe(
		"Looks like: your keys",
	);
	// Found, the live video stays and the box locks on to it; no still picture covers it.
	expect(screen.getByText("Locking on…")).toBeTruthy();
	expect(screen.queryByAltText("Camera frame that was checked")).toBeNull();
	expect(screen.getByLabelText("Live camera preview")).toBeTruthy();
	const sent = calls.filter((c) => `${c.method} ${c.path}` === DETECT);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.body).toMatchObject({
		frame: { width: 640, height: 480, rotation: 0 },
		image: { type: "image/jpeg", data: "AAAA" },
	});

	fireEvent.click(screen.getByRole("button", { name: "Not this" }));
	expect(screen.getByText(/Looks like:/).textContent).toBe(
		"Looks like: medicine. The label looks like “Aspirin”",
	);
	expect(screen.queryByRole("form", { name: "Save where it is" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	fireEvent.change(
		screen.getByRole("combobox", { name: "Where is it? A room or a spot." }),
		{ target: { value: "Hall" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Save this place" }));
	await waitFor(() =>
		expect(
			calls.find((c) => `${c.method} ${c.path}` === `POST ${MEMORY}/sightings`)
				?.body,
		).toMatchObject({
			container: "Aspirin",
			place: "Hall",
			category: "medicine",
			labelRead: true,
		}),
	);
	expect(
		await screen.findByText(
			"Saved as the last place it was seen. This does not record a dose.",
		),
	).toBeTruthy();
	// The saved thing is listed under "Where is my…?".
	expect(
		(await screen.findByRole("region", { name: "Where is my…?" })).textContent,
	).toContain("Aspirin");

	fireEvent.click(screen.getByRole("button", { name: "Look again" }));
	await waitFor(() =>
		expect(
			calls.filter((c) => `${c.method} ${c.path}` === DETECT),
		).toHaveLength(2),
	);
});

test("says nothing was found when the picture has no thing in it", async () => {
	installCamera();
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		[DETECT]: detections([]),
	});
	renderRoute("/find");

	await showVideo();
	expect(
		await screen.findByText("I could not see anything to save. Try again."),
	).toBeTruthy();
	expect(screen.queryByText("You asked")).toBeNull();
	expect(screen.queryByRole("form", { name: "Save where it is" })).toBeNull();
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
	renderRoute("/find?q=pills");

	await showVideo();
	expect(
		await screen.findByText("I can't check the picture right now."),
	).toBeTruthy();
	expect(screen.getByText(/Not a member of this family\./)).toBeTruthy();
});

test("Add a thing opens the save form for the main object at once", async () => {
	installCamera();
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		[`GET ${MEMORY}`]: memory([]),
		[DETECT]: detections([KEYS, PILLS]),
	});
	renderRoute(`/find?mode=add&member=${"a".repeat(64)}`);
	expect(
		await screen.findByRole("heading", { name: "Add a thing" }),
	).toBeTruthy();
	await showVideo();
	await screen.findByRole("form", { name: "Save where it is" });
	expect(screen.getByRole("textbox", { name: "What is it?" })).toHaveProperty(
		"value",
		"keys",
	);
});

test("a link to one saved thing opens where it was last seen", async () => {
	installCamera();
	signIn();
	const thing = (id: string, container: string, place: string) => ({
		id,
		familyId: "fam-1",
		personId: "a".repeat(64),
		savedBy: "a".repeat(64),
		container,
		place,
		seenAt: new Date().toISOString(),
		source: "camera_check",
		confidence: 0.9,
		labelRead: true,
		category: "keys",
		thumbnail: "",
		notFoundAt: null,
		usualPlace: null,
		pinned: false,
	});
	serve({
		"GET /api/families": { families: [FAMILY] },
		[`GET ${MEMORY}`]: memory([
			thing("8", "wallet", "Desk"),
			thing("9", "keys", "Hall table"),
		]),
		[DETECT]: detections([]),
	});
	renderRoute("/find?object=9");
	const region = await screen.findByRole("region", { name: "Where is my…?" });
	await waitFor(() =>
		expect(region.textContent).toContain("Last seen just now at Hall table."),
	);
	expect(region.textContent).not.toContain("at Desk.");
});
