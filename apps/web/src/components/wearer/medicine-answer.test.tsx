import "../test/setup";

import { describe, expect, mock, test } from "bun:test";
import type { ObjectDetection } from "@health/contracts/vision";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { FakeAudio, installFakeAudio } from "../test/audio";
import { fireEvent, installDom, render, serve, waitFor } from "../test/dom";
import { ObjectAnswer } from "./medicine-answer";
import type { CheckResult, PictureCheck } from "./medicine-check";

installDom();
installFakeAudio();

type Props = ComponentProps<typeof ObjectAnswer>;

/** Renders the answer at `/` in a router that also has `/hud`, with spies for its actions. */
const show = async (over: Partial<Props>) => {
	const actions = { look: mock(), stop: mock(), startCamera: mock() };
	const choice = { save: mock(), notThis: mock(), skipped: 0 };
	const props: Props = {
		check: null,
		best: null,
		name: "your pills",
		familyId: "f1",
		live: true,
		choice,
		...actions,
		...over,
	};
	const root = createRootRoute({ component: Outlet });
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/",
				component: () => <ObjectAnswer {...props} />,
			}),
			createRoute({
				getParentRoute: () => root,
				path: "/hud",
				component: () => <p>HUD screen</p>,
			}),
		]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	const view = render(<RouterProvider router={router} />);
	await waitFor(() => expect(view.container.textContent).not.toBe(""));
	return { view, router, ...actions, ...choice };
};

const check = (result: CheckResult): PictureCheck => ({
	id: "c1",
	picture: "data:image/jpeg;base64,AAAA",
	frame: { width: 300, height: 300 },
	capturedAt: Date.now(),
	result,
});

const box = { x: 10, y: 250, width: 40, height: 40 };

describe("ObjectAnswer", () => {
	test("asks to check the live picture", async () => {
		const { view, look } = await show({});
		expect(
			view.getByText("Point the camera at where your pills might be."),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Check this picture" }));
		expect(look).toHaveBeenCalledTimes(1);
	});

	test("says the camera is needed, and offers to go back, while it is off", async () => {
		const { view } = await show({ live: false });
		expect(
			view.getByText("To find your pills, I need to use the camera."),
		).toBeDefined();
		expect(
			view.getByRole("link", { name: "Not now" }).getAttribute("href"),
		).toBe("/hud");
	});

	test("asks to hold still while it looks, and Stop stops", async () => {
		const { view, stop } = await show({ check: check({ kind: "looking" }) });
		expect(
			view.getByText("Looking for your pills… Hold the phone still."),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Stop" }));
		expect(stop).toHaveBeenCalledTimes(1);
	});

	test("with the camera off, Look again waits and Turn on camera starts it", async () => {
		const { view, look, startCamera } = await show({
			check: check({ kind: "done", detections: [] }),
			live: false,
		});
		const again = view.getByRole("button", { name: "Look again" });
		expect(again.hasAttribute("disabled")).toBe(true);
		fireEvent.click(again);
		expect(look).not.toHaveBeenCalled();
		expect(
			view.getByText("The camera is off. Turn it on to look again."),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Turn on camera" }));
		expect(startCamera).toHaveBeenCalledTimes(1);
	});

	test.each<[CheckResult, string]>([
		// The "not set up" suffix depends on the sign-in env the module first loaded with.
		[{ kind: "signed_out" }, "Sign in to check pictures."],
		[
			{ kind: "forbidden", message: "Not a member." },
			"You can't check pictures for this person. Not a member.",
		],
		[
			{ kind: "unavailable", message: "No key." },
			"The picture checker is not available right now. No key.",
		],
		[
			{ kind: "error", message: "HTTP 500" },
			"Something went wrong while checking the picture. HTTP 500",
		],
	])("says a failed check showed no marker (%o)", async (result, reason) => {
		const { view, look } = await show({ check: check(result) });
		const alert = view.getByRole("alert");
		expect(alert.textContent).toStartWith(
			`I can't check the picture right now.No marker is shown because nothing was checked.${reason}`,
		);
		fireEvent.click(view.getByRole("button", { name: "Try again" }));
		expect(look).toHaveBeenCalledTimes(1);
	});

	test("says none was found, and offers to look again", async () => {
		const { view, look } = await show({
			check: check({ kind: "done", detections: [] }),
		});
		expect(
			view.getByText("I could not see anything to save. Try again."),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Look again" }));
		expect(look).toHaveBeenCalledTimes(1);
	});

	test("names an unsure medicine, reads it aloud, and offers Save and Not this", async () => {
		const calls = serve({
			"POST /api/families/f1/voice/speech": { json: "mp3" },
		});
		const best: ObjectDetection = {
			category: "medicine",
			label: "Lisinopril",
			confidence: 0.6,
			needsVerification: true,
			box,
		};
		const { view, save, notThis } = await show({
			check: check({ kind: "done", detections: [best] }),
			best,
		});
		expect(view.getByText(/Looks like:/).textContent).toBe(
			"Looks like: medicine. The label looks like “Lisinopril”",
		);
		for (const line of [
			"Look to the left, low down.",
			"I'm not sure about this one. Look closely at the label.",
			"Check the label on the box before you take anything.",
		])
			expect(view.getByText(line)).toBeDefined();

		fireEvent.click(view.getByRole("button", { name: "Read it aloud" }));
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Speaking…"),
		);
		expect(calls[0]?.body).toEqual({
			text: "Looks like medicine. The label looks like “Lisinopril”. Look to the left, low down. I'm not sure about this one. Look closely at the label. Check the label on the box before you take anything.",
		});
		expect(FakeAudio.made.length).toBe(1);
		expect(view.getByRole("button", { name: "Say it again" })).toBeDefined();

		fireEvent.click(view.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledTimes(1);
		fireEvent.click(view.getByRole("button", { name: "Not this" }));
		expect(notThis).toHaveBeenCalledTimes(1);
	});

	test("names any other thing plainly, with no label rule", async () => {
		const best: ObjectDetection = {
			category: "keys",
			label: "keys",
			confidence: 0.9,
			needsVerification: false,
			box: { x: 130, y: 0, width: 40, height: 40 },
		};
		const { view, look } = await show({
			check: check({ kind: "done", detections: [best] }),
			best,
		});
		expect(view.getByText(/Looks like:/).textContent).toBe(
			"Looks like: your keys",
		);
		expect(view.getByText("Look straight ahead, high up.")).toBeDefined();
		expect(view.queryByText(/label/)).toBeNull();
		expect(view.queryByText(/not sure/)).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Look again" }));
		expect(look).toHaveBeenCalledTimes(1);
	});

	test("after Not this on every thing, says that was everything", async () => {
		const { view } = await show({
			check: check({ kind: "done", detections: [] }),
			choice: { save: mock(), notThis: mock(), skipped: 2 },
		});
		expect(view.getByText("That was everything I found here.")).toBeDefined();
	});
});
