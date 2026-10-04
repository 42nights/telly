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

/** The finder's address: `q` is the request, `object` opens one saved thing, `member` chooses whose
 * things, `mode=add` opens Add a thing, and `token` is a signed link token another screen checks. */
type FindSearch = {
	q?: string;
	object?: string;
	member?: string;
	mode?: "add";
	token?: string;
};

// "Find things" (#301): the camera names the main object in view, Save remembers where it is, and
// "Where is my…?" lists the member's saved things. Links from messages open one thing, or Add.
export const Route = createFileRoute("/find")({
	validateSearch: (search: Record<string, unknown>): FindSearch => {
		const found: FindSearch = search.mode === "add" ? { mode: "add" } : {};
		for (const key of ["q", "object", "member", "token"] as const) {
			const value = search[key];
			// The router parses `?object=12` as the number 12; an id is a string.
			if (typeof value === "string" || typeof value === "number")
				found[key] = String(value);
		}
		return found;
	},
	component: FindThingsComponent,
});

function FindThingsComponent() {
	const { q = "", object, member, mode } = Route.useSearch();
	const { state: families, family } = useFamily();
	const familyId = family?.id ?? null;
	const camera = useCamera(true);
	const { check, look, stop } = usePictureCheck(familyId, families);
	// A link names whose things it opens; that member stays chosen on this device.
	const { memory, change, choose } = useChosenMedicineMemory(familyId, member);
	const ar = useArSupported();
	const video = useRef<HTMLVideoElement | null>(null);
	const lookNow = () => void look(video.current);
	const showVideo = useFirstLook(families.kind !== "loading", lookNow);

	const category = categoryOfRequest(q);
	const { best, choice, saving } = useArrow(check, category, mode === "add");

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
			<Window
				icon={ScanSearch}
				title={mode === "add" ? "Add a thing" : "Find things"}
			>
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
						<YouAsked q={q} />
					</div>

					<div className="win95-inset relative aspect-[4/3] min-w-0 overflow-hidden bg-card md:row-span-2">
						<CameraPreview
							camera={camera}
							onVideo={(element) => {
								video.current = element;
								showVideo();
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
							open={object ?? null}
						/>
					</div>
				</div>
			</Window>
		</main>
	);
}

/**
 * Runs the first check once the video shows a frame and `ready` (the family list answered) holds.
 * Returns what to call when the video shows.
 */
function useFirstLook(ready: boolean, lookNow: () => void) {
	const [videoShown, setVideoShown] = useState(false);
	const looked = useRef(false);
	useEffect(() => {
		if (!videoShown || looked.current || !ready) return;
		looked.current = true;
		lookNow();
	});
	return () => setVideoShown(true);
}

/** The request this screen answers, when there is one. */
function YouAsked({ q }: { q: string }) {
	if (q.trim() === "") return null;
	return (
		<p className="ml-auto grid min-w-0 justify-items-end text-right">
			<span className="text-[16px] text-muted-foreground">You asked</span>
			<b className="break-words text-[20px]">“{q}”</b>
		</p>
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
