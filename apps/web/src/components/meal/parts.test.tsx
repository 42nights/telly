import "../test/setup";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	FoodIdentity,
	MealEstimate,
	MealIntakeReport,
	MealItem,
} from "@health/contracts/meal-facts";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";
import {
	DescribeMeal,
	EstimateReview,
	EstimateStatus,
	IntakeReport,
} from "./parts";
import type { EstimateState, ReportState } from "./use-meal";

installDom();

const TRANSCRIBE = "POST /api/families/f1/voice/transcriptions";
const heard = (text: string): ServerReply => ({
	json: { text, languageCode: "en", languageProbability: 0.9 },
});

/** A microphone: `getUserMedia` gives a stream, and the recorder hands over audio on stop. */
let mic: { tracksStopped: number; fail: Error | null };
let restoreMic = () => {};
beforeEach(() => {
	mic = { tracksStopped: 0, fail: null };
	const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	const savedRecorder = globalThis.MediaRecorder;
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			getUserMedia: async () => {
				if (mic.fail !== null) throw mic.fail;
				return {
					getTracks: () => [
						{
							stop: () => {
								mic.tracksStopped += 1;
							},
						},
					],
				};
			},
		},
	});
	class FakeRecorder {
		state: "inactive" | "recording" = "inactive";
		mimeType = "audio/ogg";
		ondataavailable: ((event: { data: Blob }) => void) | null = null;
		onstop: (() => void) | null = null;
		start() {
			this.state = "recording";
		}
		stop() {
			this.state = "inactive";
			this.ondataavailable?.({ data: new Blob(["voice"]) });
			this.onstop?.();
		}
	}
	Object.assign(globalThis, { MediaRecorder: FakeRecorder });
	restoreMic = () => {
		if (saved === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
		else Object.defineProperty(navigator, "mediaDevices", saved);
		Object.assign(globalThis, { MediaRecorder: savedRecorder });
	};
});
afterEach(() => restoreMic());

const item = (name: string, overrides: Partial<MealItem> = {}): MealItem => ({
	name,
	preparation: "boiled",
	portion: "1 cup",
	energyKcal: { low: 200, high: 240 },
	proteinG: { low: 4, high: 5 },
	carbohydrateG: { low: 44, high: 50 },
	fatG: { low: 0.2, high: 0.4 },
	...overrides,
});

const estimate = (items: MealItem[]): MealEstimate => ({
	basis: "estimate",
	source: "photo",
	estimator: "model-x",
	estimatedAt: "2026-10-04T08:00:00.000Z",
	items,
});

describe("DescribeMeal", () => {
	test("sends the trimmed description, and nothing when it is blank", () => {
		serve({});
		const sent: string[] = [];
		const view = render(
			<DescribeMeal
				familyId="f1"
				initialText="  "
				onDescribe={(text) => sent.push(text)}
			/>,
		);
		const box = view.getByRole("textbox", {
			name: "No photo? Tell me what you have.",
		});
		const estimateButton = view.getByRole("button", { name: "Estimate" });
		fireEvent.click(estimateButton);
		expect(sent).toEqual([]);
		fireEvent.change(box, { target: { value: "  rice and dal " } });
		fireEvent.click(estimateButton);
		expect(sent).toEqual(["rice and dal"]);
	});

	test("starts with the text it is given, without sending it", () => {
		serve({});
		const sent: string[] = [];
		const view = render(
			<DescribeMeal
				familyId="f1"
				initialText="toast"
				onDescribe={(text) => sent.push(text)}
			/>,
		);
		expect(view.getByRole("textbox")).toHaveProperty("value", "toast");
		expect(sent).toEqual([]);
	});

	test("records speech, shows it is listening and working, then fills in and sends the words", async () => {
		let answer: (reply: ServerReply) => void = () => {};
		const calls = serve({
			[TRANSCRIBE]: () =>
				new Promise<ServerReply>((resolve) => {
					answer = resolve;
				}),
		});
		const sent: string[] = [];
		const view = render(
			<DescribeMeal
				familyId="f1"
				initialText="old text"
				onDescribe={(text) => sent.push(text)}
			/>,
		);
		fireEvent.click(view.getByRole("button", { name: "Say it" }));
		const stop = await view.findByRole("button", { name: "Stop" });
		expect(stop.getAttribute("aria-pressed")).toBe("true");
		// Pressing Talk does not submit the description.
		expect(sent).toEqual([]);
		fireEvent.click(stop);
		const working = await view.findByRole("button", { name: "Say it" });
		await waitFor(() => expect(calls.length).toBe(1));
		expect(working.hasAttribute("disabled")).toBe(true);
		expect(mic.tracksStopped).toBe(1);
		const audio = calls[0]?.body;
		expect(audio instanceof Blob && audio.type).toBe("audio/ogg");
		answer(heard(" eggs and toast "));
		await waitFor(() => expect(sent).toEqual(["eggs and toast"]));
		expect(view.getByRole("textbox")).toHaveProperty("value", "eggs and toast");
		expect(
			view.getByRole("button", { name: "Say it" }).hasAttribute("disabled"),
		).toBe(false);
		expect(view.queryByRole("alert")).toBeNull();
	});

	test.each([
		[{ status: 401 }, "Sign in to use your voice. You can type instead."],
		[{ status: 500 }, "I couldn't hear that. Try again, or type instead."],
		[heard("   "), "I didn't hear any words."],
	] as const)(
		"a failed transcription says why (%o)",
		async (reply, problem) => {
			serve({ [TRANSCRIBE]: reply });
			const sent: string[] = [];
			const view = render(
				<DescribeMeal
					familyId="f1"
					initialText=""
					onDescribe={(text) => sent.push(text)}
				/>,
			);
			fireEvent.click(view.getByRole("button", { name: "Say it" }));
			fireEvent.click(await view.findByRole("button", { name: "Stop" }));
			expect((await view.findByRole("alert")).textContent).toBe(problem);
			expect(sent).toEqual([]);
		},
	);

	test.each([
		[
			"NotAllowedError",
			"Allow the microphone for this site, then press Talk again.",
		],
		[
			"NotFoundError",
			"No microphone is available. Type your question instead.",
		],
	])(
		"a microphone failure (%s) says why and records nothing",
		async (name, problem) => {
			const calls = serve({});
			mic.fail = Object.assign(new Error("mic"), { name });
			const view = render(
				<DescribeMeal familyId="f1" initialText="" onDescribe={() => {}} />,
			);
			fireEvent.click(view.getByRole("button", { name: "Say it" }));
			expect((await view.findByRole("alert")).textContent).toBe(problem);
			expect(view.getByRole("button", { name: "Say it" })).toBeDefined();
			expect(calls).toEqual([]);
		},
	);

	test("asks for a paired person before listening, and clears the problem on retry", async () => {
		serve({});
		const view = render(
			<DescribeMeal familyId={null} initialText="" onDescribe={() => {}} />,
		);
		fireEvent.click(view.getByRole("button", { name: "Say it" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"No person is paired yet.",
		);
		view.rerender(
			<DescribeMeal familyId="f1" initialText="" onDescribe={() => {}} />,
		);
		fireEvent.click(view.getByRole("button", { name: "Say it" }));
		await view.findByRole("button", { name: "Stop" });
		expect(view.queryByRole("alert")).toBeNull();
	});

	test("leaving while listening stops the microphone and sends nothing", async () => {
		const calls = serve({ [TRANSCRIBE]: heard("rice") });
		const view = render(
			<DescribeMeal familyId="f1" initialText="" onDescribe={() => {}} />,
		);
		fireEvent.click(view.getByRole("button", { name: "Say it" }));
		await view.findByRole("button", { name: "Stop" });
		view.unmount();
		expect(mic.tracksStopped).toBe(1);
		await Bun.sleep(10);
		expect(calls).toEqual([]);
	});
});

describe("EstimateReview", () => {
	test("labels the estimate and shows each food's amounts as ranges", () => {
		const view = render(
			<EstimateReview
				estimate={estimate([item("Rice")])}
				onCorrect={() => {}}
			/>,
		);
		expect(view.getByRole("heading").textContent).toContain(
			"Estimate, not a measurement",
		);
		const tip = view.getByRole("button", { name: /^Estimated by/ });
		expect(tip.getAttribute("aria-label")).toMatch(
			/^Estimated by model-x from a photo at .+\. Amounts are for the food served, not what you ate\.$/,
		);
		expect(
			view.getByText(
				"about 200–240 kcal · protein 4–5 g · carbohydrate 44–50 g · fat 0 g",
			),
		).toBeDefined();
		expect(view.getByRole("textbox", { name: "Food" })).toHaveProperty(
			"value",
			"Rice",
		);
		expect(view.getByRole("textbox", { name: "Cooked how" })).toHaveProperty(
			"value",
			"boiled",
		);
		expect(
			view.getByRole("textbox", { name: "Served portion" }),
		).toHaveProperty("value", "1 cup");
	});

	test.each([
		["description", "your description"],
		["correction", "your correction"],
	] as const)("names a %s as the source", (source, text) => {
		const view = render(
			<EstimateReview
				estimate={{ ...estimate([item("Rice")]), source }}
				onCorrect={() => {}}
			/>,
		);
		expect(
			view
				.getByRole("button", { name: /^Estimated by/ })
				.getAttribute("aria-label"),
		).toContain(`from ${text} at`);
	});

	test("with no food found, says so and cannot update", () => {
		const view = render(
			<EstimateReview estimate={estimate([])} onCorrect={() => {}} />,
		);
		expect(
			view.getByText(
				"I couldn't see food. Add it below, or describe the meal.",
			),
		).toBeDefined();
		expect(
			view
				.getByRole("button", { name: "Update estimate" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	test("sends the corrected foods, trimmed, with a blank preparation as not known", () => {
		const corrections: FoodIdentity[][] = [];
		const view = render(
			<EstimateReview
				estimate={estimate([item("Rice"), item("Dal")])}
				onCorrect={(items) => corrections.push(items)}
			/>,
		);
		const [riceName] = view.getAllByRole("textbox", { name: "Food" });
		const [ricePrep, dalPrep] = view.getAllByRole("textbox", {
			name: "Cooked how",
		});
		const [ricePortion] = view.getAllByRole("textbox", {
			name: "Served portion",
		});
		if (!riceName || !ricePrep || !dalPrep || !ricePortion)
			throw new Error("missing fields");
		fireEvent.change(riceName, { target: { value: " Brown rice " } });
		fireEvent.change(ricePrep, { target: { value: "" } });
		fireEvent.change(dalPrep, { target: { value: "   " } });
		fireEvent.change(ricePortion, { target: { value: " 2 cups " } });
		expect(ricePrep.getAttribute("placeholder")).toBe("Not known");
		expect(ricePrep).toHaveProperty("value", "");
		fireEvent.click(view.getByRole("button", { name: "Update estimate" }));
		expect(corrections).toEqual([
			[
				{ name: "Brown rice", preparation: null, portion: "2 cups" },
				{ name: "Dal", preparation: null, portion: "1 cup" },
			],
		]);
	});

	test("a food without a name or portion blocks the update", () => {
		const view = render(
			<EstimateReview
				estimate={estimate([item("Rice")])}
				onCorrect={() => {}}
			/>,
		);
		const update = view.getByRole("button", { name: "Update estimate" });
		const name = view.getByRole("textbox", { name: "Food" });
		const portion = view.getByRole("textbox", { name: "Served portion" });
		fireEvent.change(name, { target: { value: "  " } });
		expect(update.hasAttribute("disabled")).toBe(true);
		fireEvent.change(name, { target: { value: "Rice" } });
		fireEvent.change(portion, { target: { value: "" } });
		expect(update.hasAttribute("disabled")).toBe(true);
		fireEvent.change(portion, { target: { value: "1 bowl" } });
		expect(update.hasAttribute("disabled")).toBe(false);
	});

	test("adds a new food without amounts, up to 20 foods", () => {
		const view = render(
			<EstimateReview
				estimate={estimate(
					Array.from({ length: 19 }, (_, i) => item(`Food ${i}`)),
				)}
				onCorrect={() => {}}
			/>,
		);
		const add = view.getByRole("button", { name: "Add food" });
		expect(add.hasAttribute("disabled")).toBe(false);
		fireEvent.click(add);
		expect(view.getAllByRole("listitem").length).toBe(20);
		expect(
			view.getByText("New food: update the estimate to see amounts."),
		).toBeDefined();
		expect(add.hasAttribute("disabled")).toBe(true);
		// The new food is still empty, so the estimate cannot be updated yet.
		expect(
			view
				.getByRole("button", { name: "Update estimate" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	test("removes a food by its name, or an unnamed one", () => {
		const corrections: FoodIdentity[][] = [];
		const view = render(
			<EstimateReview
				estimate={estimate([item("Rice"), item("Dal")])}
				onCorrect={(items) => corrections.push(items)}
			/>,
		);
		fireEvent.click(view.getByRole("button", { name: "Add food" }));
		fireEvent.click(view.getByRole("button", { name: "Remove this food" }));
		fireEvent.click(view.getByRole("button", { name: "Remove Rice" }));
		expect(view.getAllByRole("listitem").length).toBe(1);
		fireEvent.click(view.getByRole("button", { name: "Update estimate" }));
		expect(corrections).toEqual([
			[{ name: "Dal", preparation: "boiled", portion: "1 cup" }],
		]);
	});
});

describe("EstimateStatus", () => {
	test("shows nothing while idle or once there is an estimate", () => {
		for (const state of [
			{ kind: "idle" },
			{ kind: "done", estimate: estimate([]) },
		] satisfies EstimateState[]) {
			const view = render(<EstimateStatus state={state} />);
			expect(view.container.textContent).toBe("");
			view.unmount();
		}
	});

	test("shows that it is estimating", () => {
		const view = render(<EstimateStatus state={{ kind: "estimating" }} />);
		expect(view.getByRole("status").textContent).toBe("Estimating…");
	});

	test.each([
		[{ kind: "signed_out" }, "Sign in to get a meal estimate."],
		[
			{ kind: "forbidden", message: "x" },
			"You can't add meals for this person.",
		],
		[
			{ kind: "unavailable", message: "x" },
			"Meal estimates are not available right now. You can still say how much you ate below.",
		],
		[
			{ kind: "error", message: "x" },
			"The estimate did not work. Try again, or describe the meal instead.",
		],
	] satisfies [EstimateState, string][])(
		"explains a %o failure",
		(state, text) => {
			const view = render(<EstimateStatus state={state} />);
			expect(view.getByRole("alert").textContent).toBe(text);
		},
	);
});

describe("IntakeReport", () => {
	const setup = (familyId: string | null = "f1") => {
		const reports: [MealIntakeReport, string][] = [];
		const view = render(
			<IntakeReport
				familyId={familyId}
				onReport={(body, saved) => reports.push([body, saved])}
				report={{ kind: "idle" }}
			/>,
		);
		return { reports, view };
	};

	test("a tap reports the amount by the wearer, with no words", () => {
		serve({});
		const { reports, view } = setup();
		for (const name of ["None", "Some", "All", "Not sure"])
			fireEvent.click(view.getByRole("button", { name }));
		expect(reports).toEqual(
			(
				[
					["none", "none"],
					["some", "some"],
					["all", "all"],
					["unknown", "not sure"],
				] as const
			).map(([amount, saved]) => [
				{
					type: "intake_report",
					kind: "meal",
					amount,
					words: null,
					reportedBy: "wearer",
					via: "tap",
				},
				saved,
			]),
		);
	});

	test("typed words are saved verbatim as text, and go with a tapped amount", () => {
		serve({});
		const { reports, view } = setup();
		const save = view.getByRole("button", { name: "Save my words" });
		expect(save.hasAttribute("disabled")).toBe(true);
		const words = view.getByRole("textbox", { name: "Or in your own words" });
		fireEvent.change(words, { target: { value: "   " } });
		expect(save.hasAttribute("disabled")).toBe(true);
		fireEvent.change(words, { target: { value: " rice, not dal " } });
		fireEvent.click(save);
		fireEvent.click(view.getByRole("button", { name: "Some" }));
		const report = {
			type: "intake_report",
			kind: "meal",
			words: "rice, not dal",
			reportedBy: "wearer",
			via: "text",
		} as const;
		expect(reports).toEqual([
			[{ ...report, amount: "unknown" }, "“rice, not dal”"],
			[{ ...report, amount: "some" }, "some"],
		]);
	});

	test("spoken words are saved as voice", async () => {
		serve({ [TRANSCRIBE]: heard("half the rice") });
		const { reports, view } = setup();
		fireEvent.click(view.getByRole("button", { name: "Say it" }));
		fireEvent.click(await view.findByRole("button", { name: "Stop" }));
		await waitFor(() =>
			expect(
				view.getByRole("textbox", { name: "Or in your own words" }),
			).toHaveProperty("value", "half the rice"),
		);
		fireEvent.click(view.getByRole("button", { name: "Save my words" }));
		expect(reports).toEqual([
			[
				{
					type: "intake_report",
					kind: "meal",
					amount: "unknown",
					words: "half the rice",
					reportedBy: "wearer",
					via: "voice",
				},
				"“half the rice”",
			],
		]);
	});

	test("a caregiver's answer is reported as the caregiver's", () => {
		serve({});
		const { reports, view } = setup();
		const caregiver = view.getByRole("checkbox", {
			name: "A caregiver is answering",
		});
		fireEvent.click(caregiver);
		fireEvent.click(view.getByRole("button", { name: "All" }));
		fireEvent.click(caregiver);
		fireEvent.click(view.getByRole("button", { name: "All" }));
		expect(
			reports.map(([body]) => "reportedBy" in body && body.reportedBy),
		).toEqual(["caregiver", "wearer"]);
	});

	test("saves the help given, trimmed, then clears it; blank help sends nothing", () => {
		serve({});
		const { reports, view } = setup();
		const help = view.getByRole("textbox", {
			name: "Help given with this meal",
		});
		const save = view.getByRole("button", { name: "Save help" });
		fireEvent.change(help, { target: { value: "  " } });
		fireEvent.click(save);
		expect(reports).toEqual([]);
		fireEvent.change(help, { target: { value: " cut the food " } });
		fireEvent.click(save);
		expect(reports).toEqual([
			[
				{ type: "caregiver_assistance", help: "cut the food" },
				"help: cut the food",
			],
		]);
		expect(help).toHaveProperty("value", "");
	});

	test("while saving, says so and blocks every answer", () => {
		const view = render(
			<IntakeReport
				familyId="f1"
				onReport={() => {}}
				report={{ kind: "saving" }}
			/>,
		);
		expect(view.getByText("Saving…")).toBeDefined();
		for (const name of ["None", "Some", "All", "Not sure", "Save help"])
			expect(view.getByRole("button", { name }).hasAttribute("disabled")).toBe(
				true,
			);
	});

	test("confirms what was saved", () => {
		const report: ReportState = {
			kind: "saved",
			meal: { mealId: "m1", intake: "reported", facts: [] },
			saved: "some",
		};
		const view = render(
			<IntakeReport familyId="f1" onReport={() => {}} report={report} />,
		);
		expect(view.getByText("Saved: some")).toBeDefined();
		expect(view.queryByRole("alert")).toBeNull();
	});

	test.each([
		[{ kind: "signed_out" }, "Sign in to save this."],
		[
			{ kind: "forbidden", message: "x" },
			"You can't add meals for this person.",
		],
		[
			{ kind: "unavailable", message: "x" },
			"This could not be saved right now. Try again soon.",
		],
		[{ kind: "error", message: "x" }, "This could not be saved. Try again."],
	] satisfies [ReportState, string][])(
		"explains a %o failure",
		(report, text) => {
			const view = render(
				<IntakeReport familyId="f1" onReport={() => {}} report={report} />,
			);
			expect(view.getByRole("alert").textContent).toBe(text);
		},
	);
});
