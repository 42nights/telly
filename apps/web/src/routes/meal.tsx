import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Camera, RotateCcw, Utensils } from "lucide-react";
import { useRef, useState } from "react";

import { CameraPreview, useCamera } from "@/components/hud/camera-preview";
import { Window } from "@/components/hud/window";
import {
	DescribeMeal,
	EstimateReview,
	EstimateStatus,
	IntakeReport,
} from "@/components/meal/parts";
import { useMeal } from "@/components/meal/use-meal";
import { Tip } from "@/components/win95";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/meal")({
	// `dish`: a meal the wearer made with guided cooking (#42) and chose to record.
	validateSearch: (search: Record<string, unknown>): { dish?: string } =>
		typeof search.dish === "string" ? { dish: search.dish.slice(0, 2000) } : {},
	component: MealRoute,
});

/** Keyed by the selected person, so one person's photo, estimate, or report never shows for another. */
function MealRoute() {
	const familyId = useFamily().family?.id ?? null;
	return <MealScreen familyId={familyId} key={familyId ?? "none"} />;
}

/**
 * A meal: a photo or a description gives an estimate of the food served, which the wearer can
 * correct. How much was eaten is a separate answer; the photo and the estimate never decide it.
 */
function MealScreen({ familyId }: { familyId: string | null }) {
	const { dish } = Route.useSearch();
	const camera = useCamera(false);
	const video = useRef<HTMLVideoElement | null>(null);
	const meal = useMeal(familyId);
	// A phone shows one part at a time (captain: no page scroll); wider screens show both side by side.
	const [part, setPart] = useState<"food" | "eaten">("food");
	const tab = (value: typeof part, label: string) => (
		<button
			aria-selected={part === value}
			className="win95-sheet-tab"
			onClick={() => setPart(value)}
			role="tab"
			type="button"
		>
			{label}
		</button>
	);

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
			<Window icon={Utensils} title="Meal">
				<div className="grid gap-3 p-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-x-8 md:p-5">
					<div className="flex items-end gap-2 md:col-span-2">
						<div
							aria-label="Meal parts"
							className="flex md:hidden"
							role="tablist"
						>
							{tab("food", "Food")}
							{tab("eaten", "How much")}
						</div>
						<Tip text="The photo is used once for the estimate and is not saved." />
						<Button
							className="ml-auto h-12 text-[18px] [&_svg]:size-5"
							onClick={() => {
								meal.newMeal();
								video.current = null;
								setPart("food");
							}}
							variant="outline"
						>
							<RotateCcw aria-hidden />
							New meal
						</Button>
					</div>

					<div
						className={`grid min-w-0 content-start gap-4 ${part === "food" ? "" : "max-md:hidden"}`}
					>
						<div className="win95-inset relative aspect-[4/3] min-w-0 overflow-hidden bg-card">
							{meal.photo === null ? (
								<CameraPreview
									camera={camera}
									onVideo={(element) => {
										video.current = element;
									}}
								>
									<Button
										className="win95-primary h-12 text-[18px]"
										onClick={() => {
											meal.takePhoto(video.current);
											setPart("eaten");
										}}
									>
										<Camera aria-hidden />
										Take photo
									</Button>
								</CameraPreview>
							) : (
								<img
									alt="The meal as sent for the estimate"
									className="absolute inset-0 size-full bg-black object-contain"
									src={meal.photo}
								/>
							)}
						</div>
						<DescribeMeal
							familyId={familyId}
							initialText={dish ?? ""}
							onDescribe={(text) => {
								void meal.estimateFrom({ source: "description", text });
								setPart("eaten");
							}}
						/>
					</div>

					<div
						aria-live="polite"
						className={`grid min-w-0 content-start gap-6 ${part === "eaten" ? "" : "max-md:hidden"}`}
					>
						<EstimateStatus state={meal.estimate} />
						{meal.estimate.kind === "done" && (
							<EstimateReview
								estimate={meal.estimate.estimate}
								key={meal.estimate.estimate.estimatedAt}
								onCorrect={(items) =>
									void meal.estimateFrom({ source: "correction", items })
								}
							/>
						)}
						<IntakeReport
							familyId={familyId}
							key={meal.mealId}
							onReport={(body, saved) => void meal.reportIntake(body, saved)}
							report={meal.report}
						/>
					</div>
				</div>
			</Window>
		</main>
	);
}
