import { buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ScanSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CameraPreview, useCamera } from "@/components/hud/camera-preview";
import { Window } from "@/components/hud/window";
import {
	RememberPlace,
	SavedThings,
	useArSupported,
} from "@/components/wearer/last-seen";
import { categoryOfRequest, itemFromRequest } from "@/components/wearer/logic";
import { ObjectAnswer } from "@/components/wearer/medicine-answer";
import { useArrow, usePictureCheck } from "@/components/wearer/medicine-check";
import { CheckedPicture } from "@/components/wearer/medicine-picture";
import { Tip } from "@/components/win95";
import { useFamily } from "@/lib/family";
import {
	useChosenMedicineMemory,
	WhoseMedicinesPicker,
} from "@/lib/medicine-memory";

// "Find things" (#301): the camera names the main object in view, Save remembers where it is, and
// "Where is my…?" lists the member's saved things. The path stays /medicine for old links.
export const Route = createFileRoute("/medicine")({
	validateSearch: (search: Record<string, unknown>): { q?: string } =>
		typeof search.q === "string" ? { q: search.q } : {},
	component: FindThingsComponent,
});

function FindThingsComponent() {
	const { q = "" } = Route.useSearch();
	const { state: families, family } = useFamily();
	const familyId = family?.id ?? null;
	const camera = useCamera(true);
	const { check, look, stop } = usePictureCheck(familyId, families);
	const { memory, change, choose } = useChosenMedicineMemory(familyId);
	const ar = useArSupported();
	const video = useRef<HTMLVideoElement | null>(null);
	const lookNow = () => void look(video.current);

	// The first check runs once the video shows a frame and the family list has answered.
	const [videoShown, setVideoShown] = useState(false);
	const autoLooked = useRef(false);
	useEffect(() => {
		if (!videoShown || autoLooked.current || families.kind === "loading")
			return;
		autoLooked.current = true;
		lookNow();
	});

	const asked = q.trim() !== "";
	const category = categoryOfRequest(q);
	const { best, choice, saving } = useArrow(check, category);

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
			<Window icon={ScanSearch} title="Find things">
				<div className="grid gap-4 p-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-x-8 md:p-5">
					<div className="flex flex-wrap items-end justify-between gap-3 md:col-span-2">
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
						<WhoseMedicinesPicker
							choose={choose}
							className="[&_select]:min-w-0 [&_select]:flex-1"
							memory={memory}
						/>
						{asked && (
							<p className="ml-auto grid min-w-0 justify-items-end text-right">
								<span className="text-[16px] text-muted-foreground">
									You asked
								</span>
								<b className="break-words text-[20px]">“{q}”</b>
							</p>
						)}
					</div>

					<div className="win95-inset relative aspect-[4/3] min-w-0 overflow-hidden bg-card md:row-span-2">
						<CameraPreview
							camera={camera}
							onVideo={(element) => {
								video.current = element;
								setVideoShown(true);
							}}
						/>
						{check !== null && <CheckedPicture best={best} check={check} />}
					</div>

					<div
						aria-live="polite"
						className="grid min-w-0 content-start gap-3 text-[20px]"
					>
						<ObjectAnswer
							best={best}
							check={check}
							choice={choice}
							familyId={familyId}
							live={camera.state.kind === "live"}
							look={lookNow}
							name={<AskedItem q={q} />}
							startCamera={camera.start}
							stop={stop}
						/>
						{best !== null && saving && check !== null && (
							<RememberPlace
								ar={ar ? familyId : null}
								best={best}
								change={change}
								check={check}
								key={`${check.id}:${choice.skipped}`}
								memory={memory}
							/>
						)}
						<SavedThings
							ar={ar}
							asked={category}
							change={change}
							familyId={familyId}
							memory={memory}
						/>
					</div>
				</div>
			</Window>
		</main>
	);
}

/** The thing the request names, with where that name came from. */
function AskedItem({ q }: { q: string }) {
	return (
		<>
			<b>{itemFromRequest(q)}</b>
			<Tip
				text={
					q.trim() === ""
						? "No request was given, so I look for the main thing in view."
						: `From your request “${q}”.`
				}
			/>
		</>
	);
}
