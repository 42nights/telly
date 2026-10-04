import { buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pill } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CameraPreview, useCamera } from "@/components/hud/camera-preview";
import { Window } from "@/components/hud/window";
import { itemFromRequest } from "@/components/wearer/logic";
import { MedicineAnswer } from "@/components/wearer/medicine-answer";
import {
	bestDetection,
	usePictureCheck,
} from "@/components/wearer/medicine-check";
import { CheckedPicture } from "@/components/wearer/medicine-picture";
import { Tip } from "@/components/win95";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/medicine")({
	validateSearch: (search: Record<string, unknown>): { q?: string } =>
		typeof search.q === "string" ? { q: search.q } : {},
	component: MedicineComponent,
});

function MedicineComponent() {
	const { q = "" } = Route.useSearch();
	const { state: families, family } = useFamily();
	const familyId = family?.id ?? null;
	const camera = useCamera(true);
	const { check, look, stop } = usePictureCheck(familyId, families);
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
	const item = itemFromRequest(q);
	const name = (
		<>
			<b>{item}</b>
			<Tip
				text={
					asked
						? `From your request “${q}”.`
						: "No request was given, so I look for any medicine container."
				}
			/>
		</>
	);
	const best =
		check?.result.kind === "done"
			? bestDetection(check.result.detections)
			: null;

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
			<Window icon={Pill} title="Find medicine">
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
						<MedicineAnswer
							best={best}
							check={check}
							familyId={familyId}
							item={item}
							live={camera.state.kind === "live"}
							look={lookNow}
							name={name}
							startCamera={camera.start}
							stop={stop}
						/>
					</div>
				</div>
			</Window>
		</main>
	);
}
