import { expect, test } from "bun:test";
import type { Call } from "@/lib/test/app";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const ESTIMATES = /^\/api\/families\/fam-1\/meals\/([^/]+)\/estimates$/;

const estimate = (source: string) => ({
	basis: "estimate",
	source,
	estimator: "vision-model",
	estimatedAt: `2026-10-01T12:00:0${source.length % 10}.000Z`,
	items: [
		{
			name: "Rice",
			preparation: "boiled",
			portion: "1 cup",
			energyKcal: { low: 200, high: 240 },
			proteinG: { low: 4, high: 4 },
			carbohydrateG: { low: 45, high: 50 },
			fatG: { low: 0, high: 1 },
		},
	],
});

const meal = { intake: "reported", facts: [] };

// A fake camera: one stream, frames painted at once, and a canvas that encodes a tiny JPEG.
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
	Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
		configurable: true,
		get: () => 640,
	});
	Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
		configurable: true,
		get: () => 480,
	});
	const canvas = HTMLCanvasElement.prototype as unknown as Record<
		string,
		unknown
	>;
	canvas.getContext = () => ({ drawImage: () => {} });
	canvas.toDataURL = () => "data:image/jpeg;base64,AAAA";
}

const route = (familyCalls: Record<string, unknown>) => {
	signIn();
	return serve({ "GET /api/families": { families: [FAMILY] }, ...familyCalls });
};

// The screen is keyed by person and remounts once the family list answers; act after that.
const DESCRIBE = "No photo? Tell me what you have.";
async function loaded() {
	const first = await screen.findByLabelText(DESCRIBE);
	await waitFor(() => expect(screen.getByLabelText(DESCRIBE)).not.toBe(first));
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

test("estimates a described meal, sends a correction, and saves how much was eaten", async () => {
	let n = 0;
	const calls = route({});
	// Each estimate request is answered by path, whatever the meal id is.
	const fetchMeals = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		if (ESTIMATES.test(path)) {
			await fetchMeals(input, init);
			n += 1;
			return json(200, estimate(n === 1 ? "description" : "correction"));
		}
		if (path.endsWith("/intake")) {
			await fetchMeals(input, init);
			const mealId = path.split("/")[5] ?? "";
			return json(200, { ...meal, mealId });
		}
		return fetchMeals(input, init);
	}) as typeof fetch;
	renderRoute("/meal?dish=Dal%20and%20rice");
	await loaded();

	const description = (await screen.findByLabelText(
		"No photo? Tell me what you have.",
	)) as HTMLTextAreaElement;
	expect(description.value).toBe("Dal and rice");
	fireEvent.click(screen.getByRole("button", { name: "Estimate" }));

	expect(
		await screen.findByText(
			"about 200–240 kcal · protein 4 g · carbohydrate 45–50 g · fat 0–1 g",
		),
	).toBeTruthy();
	const first = posts(calls)[0];
	expect(first?.path).toMatch(ESTIMATES);
	expect(first?.body).toEqual({ source: "description", text: "Dal and rice" });

	fireEvent.change(screen.getByDisplayValue("Rice"), {
		target: { value: "Brown rice" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Update estimate" }));
	await waitFor(() => expect(posts(calls)).toHaveLength(2));
	expect(posts(calls)[1]?.body).toEqual({
		source: "correction",
		items: [{ name: "Brown rice", preparation: "boiled", portion: "1 cup" }],
	});
	// The same meal gets the correction.
	expect(posts(calls)[1]?.path).toBe(first?.path ?? "");

	fireEvent.click(await screen.findByRole("button", { name: "Some" }));
	expect(await screen.findByText("Saved: some")).toBeTruthy();
	const intake = posts(calls)[2];
	expect(intake?.path).toBe(
		(first?.path ?? "").replace(/estimates$/, "intake"),
	);
	expect(intake?.body).toEqual({
		type: "intake_report",
		kind: "meal",
		amount: "some",
		words: null,
		reportedBy: "wearer",
		via: "tap",
	});

	// A new meal clears the estimate and the report, and uses a new meal id.
	fireEvent.click(screen.getByRole("button", { name: "New meal" }));
	expect(screen.queryByRole("region", { name: "Meal estimate" })).toBeNull();
	expect(screen.queryByText("Saved: some")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "All" }));
	await waitFor(() => expect(posts(calls)).toHaveLength(4));
	expect(posts(calls)[3]?.path).not.toBe(intake?.path ?? "");
});

test("takes a photo from the camera, shows it, and sends it for an estimate", async () => {
	installCamera();
	const calls = route({});
	const fetchMeals = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const reply = await fetchMeals(input, init);
		return ESTIMATES.test(new URL(String(input)).pathname)
			? json(200, estimate("photo"))
			: reply;
	}) as typeof fetch;
	renderRoute("/meal");

	await loaded();
	fireEvent.click(screen.getByRole("button", { name: "Turn on camera" }));
	const video = await screen.findByLabelText("Live camera preview");
	fireEvent.loadedData(video);
	fireEvent.click(screen.getByRole("button", { name: "Take photo" }));

	const photo = (await screen.findByAltText(
		"The meal as sent for the estimate",
	)) as HTMLImageElement;
	expect(photo.src).toBe("data:image/jpeg;base64,AAAA");
	expect(
		await screen.findByRole("region", { name: "Meal estimate" }),
	).toBeTruthy();
	const sent = posts(calls)[0];
	expect(sent?.path).toMatch(ESTIMATES);
	expect(sent?.body).toMatchObject({
		source: "photo",
		image: { type: "image/jpeg", data: "AAAA" },
	});

	// A new meal brings the camera back in place of the photo.
	fireEvent.click(screen.getByRole("button", { name: "New meal" }));
	expect(screen.queryByAltText("The meal as sent for the estimate")).toBeNull();
	expect(await screen.findByLabelText("Live camera preview")).toBeTruthy();
});

test("says the caller cannot add meals for a person they are not a member of", async () => {
	route({});
	globalThis.fetch = (async (input: RequestInfo | URL) =>
		new URL(String(input)).pathname === "/api/families"
			? json(200, { families: [FAMILY] })
			: json(403, {
					error: "forbidden",
					message: "Not a member.",
				})) as typeof fetch;
	renderRoute("/meal");
	await loaded();

	fireEvent.change(screen.getByLabelText("No photo? Tell me what you have."), {
		target: { value: "Soup" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
	expect(
		await screen.findByText("You can't add meals for this person."),
	).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "None" }));
	await waitFor(() =>
		expect(
			screen.getAllByText("You can't add meals for this person."),
		).toHaveLength(2),
	);
});

test("asks a signed-out visitor to pair a person and sends no meal request", async () => {
	const calls = serve({});
	renderRoute("/meal");

	fireEvent.change(
		await screen.findByLabelText("No photo? Tell me what you have."),
		{ target: { value: "Soup" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
	expect(
		await screen.findByText(
			"The estimate did not work. Try again, or describe the meal instead.",
		),
	).toBeTruthy();
	expect(calls).toEqual([]);
});
