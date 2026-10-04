import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { ObjectDetection } from "@health/contracts/vision";
import { installDom, render } from "../test/dom";

import type { CheckResult, PictureCheck } from "./medicine-check";
import { CheckedPicture } from "./medicine-picture";

installDom();

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

const detection = (
	label: string | null,
	needsVerification: boolean,
	box: ObjectDetection["box"],
	confidence = 0.8,
	category: ObjectDetection["category"] = "medicine",
): ObjectDetection => ({ category, label, needsVerification, confidence, box });

const check = (result: CheckResult, capturedAt = NOW): PictureCheck => ({
	id: "c1",
	picture: "data:image/jpeg;base64,AAAA",
	frame: { width: 400, height: 300 },
	capturedAt,
	result,
});

const texts = (root: HTMLElement) =>
	[...root.querySelectorAll("svg text")].map((t) => t.textContent);

describe("CheckedPicture", () => {
	test("shows the checked picture with a checking tag and no markers while it looks", () => {
		const view = render(
			<CheckedPicture best={null} check={check({ kind: "looking" })} />,
		);
		const picture = view.getByRole("img", {
			name: "Camera frame that was checked",
		});
		expect(picture.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
		expect(view.getByText("Checking this picture…")).toBeDefined();
		expect(texts(view.container)).toEqual([]);
		expect(
			view.container.querySelector('svg[viewBox="0 0 400 300"]'),
		).not.toBeNull();
	});

	test("tags a failed check as not checked", () => {
		const view = render(
			<CheckedPicture
				best={null}
				check={check({ kind: "error", message: "boom" })}
			/>,
		);
		expect(view.getByText("Picture not checked")).toBeDefined();
	});

	test("shows nothing once the markers were cleared", () => {
		const view = render(
			<CheckedPicture
				best={null}
				check={check({ kind: "cleared", reason: "moved" })}
			/>,
		);
		expect(view.container.innerHTML).toBe("");
	});

	test("tells the picture's age", () => {
		const done: CheckResult = { kind: "done", detections: [] };
		const fresh = render(<CheckedPicture best={null} check={check(done)} />);
		expect(fresh.getByText("Picture taken just now")).toBeDefined();
		fresh.unmount();
		const old = render(
			<CheckedPicture best={null} check={check(done, NOW - 120_000)} />,
		);
		expect(old.getByText("Picture from 2 min ago")).toBeDefined();
	});

	test("marks each box with a sure ✓ or an unsure ? tag, and an arrow to the best one", () => {
		const best = detection("Aspirin", false, {
			x: 20,
			y: 100,
			width: 80,
			height: 60,
		});
		const detections = [
			best,
			detection(null, true, { x: 200, y: 0, width: 50, height: 40 }),
			detection("Very long medicine name on the box", true, {
				x: 300,
				y: 200,
				width: 40,
				height: 40,
			}),
			detection(null, false, { x: 100, y: 200, width: 30, height: 30 }),
			// Any other thing is named; an unsure one asks the person to check it is theirs.
			detection(
				"car keys",
				false,
				{ x: 10, y: 250, width: 20, height: 20 },
				0.9,
				"keys",
			),
			detection(
				null,
				true,
				{ x: 50, y: 250, width: 20, height: 20 },
				0.6,
				"glasses",
			),
			// Outside the frame: no marker.
			detection("Gone", false, { x: 500, y: 10, width: 20, height: 20 }),
		];
		const view = render(
			<CheckedPicture
				best={best}
				check={check({ kind: "done", detections })}
			/>,
		);
		expect(texts(view.container)).toEqual([
			"✓ Aspirin",
			"? Check the label",
			"? Very long medicine name… · check label",
			"✓ Medicine box",
			"✓ car keys",
			"? glasses · check it",
		]);
		const tags = [...view.container.querySelectorAll("svg text")];
		// Above a box that has room, below one at the top edge.
		expect(tags[0]?.getAttribute("y")).toBe("90");
		expect(tags[1]?.getAttribute("y")).toBe("64");
		// Only the best box gets the arrow (outline + line), and unsure boxes are dashed.
		expect(view.container.querySelectorAll("svg path").length).toBe(2);
		expect(view.container.querySelectorAll("svg polygon").length).toBe(1);
		expect(
			view.container.querySelectorAll("svg rect[stroke-dasharray]").length,
		).toBe(3);
	});
});
