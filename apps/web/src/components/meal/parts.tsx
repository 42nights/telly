import type {
	FoodIdentity,
	IntakeAmount,
	MealEstimate,
	MealIntakeReport,
} from "@health/contracts/meal-facts";
import { Button } from "@health/ui/components/button";
import { Loader2, Mic, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { startRecording } from "@/components/wearer/request";
import { Tip } from "@/components/win95";

import { type EstimateState, type ReportState, transcribe } from "./use-meal";

const field =
	"win95-inset win95-field h-12 min-w-0 bg-white px-3 text-[18px] text-black";
const big = "h-14 text-[18px] [&_svg]:size-5";

/** Records speech and hands over its words. Shows its own listening and failure states. */
function TalkButton({
	familyId,
	label,
	onWords,
}: {
	familyId: string | null;
	label: string;
	onWords: (words: string) => void;
}) {
	const [state, setState] = useState<"idle" | "listening" | "working">("idle");
	const [problem, setProblem] = useState<string | null>(null);
	const recording = useRef<{ stop: () => void; cancel: () => void } | null>(
		null,
	);
	useEffect(() => () => recording.current?.cancel(), []);

	const toggle = async () => {
		if (recording.current !== null) {
			recording.current.stop();
			recording.current = null;
			return;
		}
		if (familyId === null) return setProblem("No person is paired yet.");
		setProblem(null);
		const started = await startRecording(async (audio) => {
			setState("working");
			const words = await transcribe(familyId, audio);
			setState("idle");
			if (words.kind !== "ready")
				return setProblem(
					words.kind === "signed_out"
						? "Sign in to use your voice. You can type instead."
						: "I couldn't hear that. Try again, or type instead.",
				);
			if (words.value === "") return setProblem("I didn't hear any words.");
			onWords(words.value);
		});
		if (typeof started === "string") return setProblem(started);
		recording.current = started;
		setState("listening");
	};

	return (
		<div className="grid gap-1">
			<Button
				aria-pressed={state === "listening"}
				className={big}
				disabled={state === "working"}
				onClick={() => void toggle()}
				variant="outline"
			>
				{state === "working" ? (
					<Loader2 aria-hidden className="animate-spin" />
				) : state === "listening" ? (
					<Square aria-hidden />
				) : (
					<Mic aria-hidden />
				)}
				{state === "listening" ? "Stop" : label}
			</Button>
			{problem !== null && (
				<p className="text-[16px] text-destructive" role="alert">
					{problem}
				</p>
			)}
		</div>
	);
}

/** The no-camera path: say or type what the meal is. */
export function DescribeMeal({
	familyId,
	initialText,
	onDescribe,
}: {
	familyId: string | null;
	/** Filled in, not sent: the wearer still presses Estimate. */
	initialText: string;
	onDescribe: (text: string) => void;
}) {
	const [text, setText] = useState(initialText);
	return (
		<form
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (text.trim() !== "") onDescribe(text.trim());
			}}
		>
			<label className="text-[18px]" htmlFor="meal-description">
				No photo? Tell me what you have.
			</label>
			<textarea
				className={`${field} h-20 py-2`}
				id="meal-description"
				maxLength={2000}
				onChange={(event) => setText(event.target.value)}
				placeholder="Rice, dal, and a glass of milk"
				value={text}
			/>
			<div className="grid grid-cols-2 gap-2">
				<TalkButton
					familyId={familyId}
					label="Say it"
					onWords={(words) => {
						setText(words);
						onDescribe(words);
					}}
				/>
				<Button className={big} type="submit" variant="outline">
					Estimate
				</Button>
			</div>
		</form>
	);
}

const amount = ({ low, high }: { low: number; high: number }, unit: string) =>
	Math.round(low) === Math.round(high)
		? `${Math.round(low)} ${unit}`
		: `${Math.round(low)}–${Math.round(high)} ${unit}`;

const sourceText = {
	photo: "a photo",
	description: "your description",
	correction: "your correction",
} as const;

/**
 * The estimate, labelled as one, with every food editable. "Update estimate" sends the corrected
 * foods; the new nutrient ranges come back as a new estimate. Mount it with a `key` per estimate.
 */
export function EstimateReview({
	estimate,
	onCorrect,
}: {
	estimate: MealEstimate;
	onCorrect: (items: FoodIdentity[]) => void;
}) {
	const [items, setItems] = useState<FoodIdentity[]>(() =>
		estimate.items.map(({ name, preparation, portion }) => ({
			name,
			preparation,
			portion,
		})),
	);
	const change = (index: number, patch: Partial<FoodIdentity>) =>
		setItems(
			items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
		);
	const valid = items.every(
		(item) => item.name.trim() !== "" && item.portion.trim() !== "",
	);
	const at = new Date(estimate.estimatedAt).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	return (
		<section
			aria-label="Meal estimate"
			className="grid min-w-0 grid-cols-1 gap-3"
		>
			<h2 className="flex items-center gap-1 font-bold text-[22px]">
				Estimate, not a measurement
				<Tip
					align="end"
					text={`Estimated by ${estimate.estimator} from ${sourceText[estimate.source]} at ${at}. Amounts are for the food served, not what you ate.`}
				/>
			</h2>
			{items.length === 0 && (
				<p className="text-[18px]">
					I couldn't see food. Add it below, or describe the meal.
				</p>
			)}
			<ol className="grid gap-3">
				{items.map((item, index) => {
					const estimated = estimate.items[index];
					const id = `meal-item-${index}`;
					return (
						<li className="win95-inset grid gap-2 bg-card p-2" key={id}>
							<div className="grid grid-cols-2 gap-2">
								<label className="col-span-2 grid gap-1 text-[16px]">
									Food
									<input
										className={field}
										maxLength={120}
										onChange={(event) =>
											change(index, { name: event.target.value })
										}
										value={item.name}
									/>
								</label>
								<label className="grid gap-1 text-[16px]">
									Cooked how
									<input
										className={field}
										maxLength={120}
										onChange={(event) =>
											change(index, {
												preparation:
													event.target.value === "" ? null : event.target.value,
											})
										}
										placeholder="Not known"
										value={item.preparation ?? ""}
									/>
								</label>
								<label className="grid gap-1 text-[16px]">
									Served portion
									<input
										className={field}
										maxLength={120}
										onChange={(event) =>
											change(index, { portion: event.target.value })
										}
										value={item.portion}
									/>
								</label>
							</div>
							<div className="flex items-center justify-between gap-2">
								<p className="text-[16px] text-muted-foreground">
									{estimated === undefined
										? "New food: update the estimate to see amounts."
										: `about ${amount(estimated.energyKcal, "kcal")} · protein ${amount(estimated.proteinG, "g")} · carbohydrate ${amount(estimated.carbohydrateG, "g")} · fat ${amount(estimated.fatG, "g")}`}
								</p>
								<Button
									aria-label={`Remove ${item.name || "this food"}`}
									onClick={() => setItems(items.filter((_, i) => i !== index))}
									size="icon"
									variant="ghost"
								>
									<Trash2 aria-hidden />
								</Button>
							</div>
						</li>
					);
				})}
			</ol>
			<div className="grid grid-cols-2 gap-2">
				<Button
					className={big}
					disabled={items.length >= 20}
					onClick={() =>
						setItems([...items, { name: "", preparation: null, portion: "" }])
					}
					variant="outline"
				>
					<Plus aria-hidden />
					Add food
				</Button>
				<Button
					className={big}
					disabled={!valid || items.length === 0}
					onClick={() =>
						onCorrect(
							items.map((item) => ({
								name: item.name.trim(),
								preparation: item.preparation?.trim() || null,
								portion: item.portion.trim(),
							})),
						)
					}
				>
					Update estimate
				</Button>
			</div>
		</section>
	);
}

const failureText = {
	signed_out: "Sign in to get a meal estimate.",
	forbidden: "You can't add meals for this person.",
	unavailable:
		"Meal estimates are not available right now. You can still say how much you ate below.",
	error: "The estimate did not work. Try again, or describe the meal instead.",
} as const;

/** What the estimate area says while there is no estimate to show. */
export function EstimateStatus({ state }: { state: EstimateState }) {
	if (state.kind === "idle" || state.kind === "done") return null;
	if (state.kind === "estimating")
		return (
			<p className="flex items-center gap-2 text-[18px]" role="status">
				<Loader2 aria-hidden className="size-5 animate-spin" />
				Estimating…
			</p>
		);
	return (
		<p className="text-[18px] text-destructive" role="alert">
			{failureText[state.kind]}
		</p>
	);
}

const amounts: ReadonlyArray<[IntakeAmount, string]> = [
	["none", "None"],
	["some", "Some"],
	["all", "All"],
	["unknown", "Not sure"],
];

const reportFailure = {
	signed_out: "Sign in to save this.",
	forbidden: "You can't add meals for this person.",
	unavailable: "This could not be saved right now. Try again soon.",
	error: "This could not be saved. Try again.",
} as const;

/**
 * The separate intake report: how much was eaten, in the reporter's own judgement, any help given,
 * or "not sure". Nothing here is filled in from the photo or the estimate.
 */
export function IntakeReport({
	familyId,
	report,
	onReport,
}: {
	familyId: string | null;
	report: ReportState;
	onReport: (body: MealIntakeReport, saved: string) => void;
}) {
	const [words, setWords] = useState<{ text: string; spoken: boolean } | null>(
		null,
	);
	const [caregiver, setCaregiver] = useState(false);
	const [help, setHelp] = useState("");
	const reportedBy = caregiver ? "caregiver" : "wearer";
	const said = words?.text.trim() || null;
	const via = said === null ? "tap" : words?.spoken ? "voice" : "text";
	const busy = report.kind === "saving";

	return (
		<section
			aria-label="What you ate"
			className="grid min-w-0 grid-cols-1 gap-3"
		>
			<h2 className="flex items-center gap-1 font-bold text-[22px]">
				How much did you eat?
				<Tip text="Only your answer counts here. A photo never decides it." />
			</h2>
			<div className="grid grid-cols-2 gap-2">
				{amounts.map(([amount, label]) => (
					<Button
						className={big}
						disabled={busy}
						key={amount}
						onClick={() =>
							onReport(
								{
									type: "intake_report",
									kind: "meal",
									amount,
									words: said,
									reportedBy,
									via,
								},
								label.toLowerCase(),
							)
						}
						variant="outline"
					>
						{label}
					</Button>
				))}
			</div>

			<label className="grid gap-1 text-[16px]">
				Or in your own words
				<input
					className={field}
					maxLength={2000}
					onChange={(event) =>
						setWords({ text: event.target.value, spoken: false })
					}
					placeholder="I had the rice but not the dal"
					value={words?.text ?? ""}
				/>
			</label>
			<div className="grid grid-cols-2 gap-2">
				<TalkButton
					familyId={familyId}
					label="Say it"
					onWords={(text) => setWords({ text, spoken: true })}
				/>
				<Button
					className={big}
					disabled={busy || said === null}
					onClick={() =>
						said !== null &&
						onReport(
							{
								type: "intake_report",
								kind: "meal",
								amount: "unknown",
								words: said,
								reportedBy,
								via,
							},
							`“${said}”`,
						)
					}
				>
					Save my words
				</Button>
			</div>

			<label className="flex items-center gap-2 text-[18px]">
				<input
					checked={caregiver}
					className="size-5"
					onChange={(event) => setCaregiver(event.target.checked)}
					type="checkbox"
				/>
				A caregiver is answering
			</label>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (help.trim() === "") return;
					onReport(
						{ type: "caregiver_assistance", help: help.trim() },
						`help: ${help.trim()}`,
					);
					setHelp("");
				}}
			>
				<label className="sr-only" htmlFor="meal-help">
					Help given with this meal
				</label>
				<input
					className={`${field} flex-1`}
					id="meal-help"
					maxLength={500}
					onChange={(event) => setHelp(event.target.value)}
					placeholder="Help given, such as “cut the food”"
					value={help}
				/>
				<Button className={big} disabled={busy} type="submit" variant="outline">
					Save help
				</Button>
			</form>

			<div aria-live="polite">
				{report.kind === "saving" && <p className="text-[18px]">Saving…</p>}
				{report.kind === "saved" && (
					<p className="text-[18px]">Saved: {report.saved}</p>
				)}
				{report.kind !== "idle" &&
					report.kind !== "saving" &&
					report.kind !== "saved" && (
						<p className="text-[18px] text-destructive" role="alert">
							{reportFailure[report.kind]}
						</p>
					)}
			</div>
		</section>
	);
}
