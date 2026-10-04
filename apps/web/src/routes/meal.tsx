import { Button, buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Camera, RotateCcw, Utensils } from "lucide-react";
import { useRef } from "react";

import { CameraPreview, useCamera } from "@/components/hud/camera-preview";
import { Window } from "@/components/hud/window";
import {
	DescribeMeal,
	EstimateReview,
	EstimateStatus,
	IntakeReport,
} from "@/components/meal/parts";
import { useMeal } from "@/components/meal/use-meal";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/meal")({
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
	const camera = useCamera(false);
	const video = useRef<HTMLVideoElement | null>(null);
	const meal = useMeal(familyId);

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
			<Window icon={Utensils} title="Meal">
				<div className="grid gap-4 p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-x-8 md:p-5">
					<div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
						<Link
							className={buttonVariants({
								variant: "ghost",
								className: "h-12 text-[18px] [&_svg]:size-5",
							})}
							data-slot="button"
							to="/hud"
						>
							<ArrowLeft aria-hidden />
							Home
						</Link>
						<Button
							className="h-12 text-[18px] [&_svg]:size-5"
							onClick={() => {
								meal.newMeal();
								video.current = null;
							}}
							variant="outline"
						>
							<RotateCcw aria-hidden />
							New meal
						</Button>
					</div>

					<div className="grid min-w-0 content-start gap-4">
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
										onClick={() => meal.takePhoto(video.current)}
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
						<p className="text-[16px] text-muted-foreground">
							The photo is used once for the estimate and is not saved.
						</p>
						<DescribeMeal
							familyId={familyId}
							onDescribe={(text) =>
								void meal.estimateFrom({ source: "description", text })
							}
						/>
					</div>

					<div aria-live="polite" className="grid min-w-0 content-start gap-6">
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
