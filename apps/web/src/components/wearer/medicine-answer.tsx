import type { MedicineDetection } from "@health/contracts/vision";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { Camera, Check, CloudOff, Info, Square, Volume2 } from "lucide-react";
import type { ReactNode } from "react";

import type { ApiFailure } from "@/lib/api";

import { direction } from "./logic";
import type { PictureCheck } from "./medicine-check";
import { SpeechLine, useSpeech } from "./speech";

const xl = "h-16 w-full text-[22px] [&_svg]:size-7";
const lg = "h-14 w-full text-[20px] [&_svg]:size-6";

const failureText: Record<ApiFailure["kind"], string> = {
	signed_out:
		"Sign in to check pictures. Sign-in is not set up yet (issue #4).",
	forbidden: "You can't check pictures for this person.",
	unavailable: "The picture checker is not available right now.",
	error: "Something went wrong while checking the picture.",
};

type Look = () => void;

function Found({
	check,
	detections,
	best,
	name,
	item,
	familyId,
	live,
	look,
}: {
	check: PictureCheck;
	detections: readonly MedicineDetection[];
	best: MedicineDetection;
	name: ReactNode;
	item: string;
	familyId: string | null;
	live: boolean;
	look: Look;
}) {
	const navigate = useNavigate();
	const { speech, say } = useSpeech(familyId);
	const single = detections.length === 1;
	const way = direction(best.box, check.frame);
	const spoken = [
		single
			? `I marked ${item} in the picture.`
			: `I marked ${detections.length} medicine containers. The arrow points to the most likely one.`,
		way,
		best.label === null ? "" : `The label looks like “${best.label}”.`,
		best.needsVerification
			? "I'm not sure about this one. Look closely at the label."
			: "",
		"Check the label on the box before you take anything.",
	]
		.filter(Boolean)
		.join(" ");
	const saidThis = speech.key === check.id;
	return (
		<>
			<p className="text-[22px]">
				{single ? (
					<>I marked {name} in the picture.</>
				) : (
					<>
						I marked {detections.length} medicine containers. The arrow points
						to the most likely one.
					</>
				)}
			</p>
			<p className="font-semibold">{way}</p>
			{best.label !== null && (
				<p className="break-words">The label looks like “{best.label}”.</p>
			)}
			{best.needsVerification && (
				<p className="font-semibold">
					I'm not sure about this one. Look closely at the label.
				</p>
			)}
			<p className="win95-raised flex items-start gap-3 p-4 text-[18px]">
				<Info aria-hidden className="mt-0.5 size-6 shrink-0" />
				Check the label on the box before you take anything.
			</p>
			<Button
				className={lg}
				disabled={speech.kind === "loading"}
				onClick={() => void say(check.id, spoken)}
				variant="outline"
			>
				<Volume2 aria-hidden />
				{saidThis ? "Say it again" : "Read it aloud"}
			</Button>
			{saidThis && <SpeechLine speech={speech} />}
			<Button
				className={`win95-primary ${xl}`}
				onClick={() => void navigate({ to: "/hud" })}
			>
				<Check aria-hidden />I found it
			</Button>
			<Button className={lg} disabled={!live} onClick={look} variant="outline">
				<Camera aria-hidden />
				Look again
			</Button>
		</>
	);
}

function CheckFailed({
	failure,
	live,
	look,
}: {
	failure: ApiFailure;
	live: boolean;
	look: Look;
}) {
	return (
		<>
			<div
				className="win95-raised grid grid-cols-[auto_1fr] gap-3 p-4"
				role="alert"
			>
				<CloudOff aria-hidden className="size-7 text-destructive" />
				<div className="grid gap-1">
					<p className="font-semibold">I can't check the picture right now.</p>
					<p className="text-[16px]">
						No marker is shown because nothing was checked.
					</p>
					<p className="break-words text-[15px] text-muted-foreground">
						{failureText[failure.kind]}
						{failure.kind === "signed_out" ? "" : ` ${failure.message}`}
					</p>
				</div>
			</div>
			<Button className={`win95-primary ${xl}`} disabled={!live} onClick={look}>
				<Camera aria-hidden />
				Try again
			</Button>
		</>
	);
}

function PictureAnswer({
	check,
	best,
	name,
	item,
	familyId,
	live,
	look,
	stop,
}: {
	check: PictureCheck;
	best: MedicineDetection | null;
	name: ReactNode;
	item: string;
	familyId: string | null;
	live: boolean;
	look: Look;
	stop: () => void;
}) {
	const { result } = check;
	if (result.kind === "looking")
		return (
			<>
				<p className="text-[22px]">Looking for {name}… Hold the phone still.</p>
				<Button className={lg} onClick={stop} variant="outline">
					<Square aria-hidden />
					Stop
				</Button>
			</>
		);
	if (result.kind === "cleared")
		return (
			<>
				<p className="win95-raised flex items-start gap-3 p-4 text-[20px]">
					<Info aria-hidden className="mt-0.5 size-6 shrink-0" />
					{result.reason === "moved"
						? "The camera moved, so I took the marker away."
						: "That picture is more than a minute old, so I took the marker away."}
				</p>
				<Button
					className={`win95-primary ${xl}`}
					disabled={!live}
					onClick={look}
				>
					<Camera aria-hidden />
					Look again
				</Button>
			</>
		);
	if (result.kind !== "done")
		return <CheckFailed failure={result} live={live} look={look} />;
	if (best !== null)
		return (
			<Found
				best={best}
				check={check}
				detections={result.detections}
				familyId={familyId}
				item={item}
				live={live}
				look={look}
				name={name}
			/>
		);
	return (
		<>
			<p className="text-[22px]">I can't see {name} in this picture.</p>
			<p className="text-[18px] text-muted-foreground">
				None found in this picture. Point the phone at the counter or shelf and
				try again.
			</p>
			<Button className={`win95-primary ${xl}`} disabled={!live} onClick={look}>
				<Camera aria-hidden />
				Look again
			</Button>
		</>
	);
}

/** The answer column: what the wearer can do for the camera and the current picture check. */
export function MedicineAnswer({
	check,
	best,
	name,
	item,
	familyId,
	live,
	look,
	stop,
	startCamera,
}: {
	check: PictureCheck | null;
	best: MedicineDetection | null;
	name: ReactNode;
	item: string;
	familyId: string | null;
	live: boolean;
	look: Look;
	stop: () => void;
	startCamera: () => void;
}) {
	if (check === null)
		return live ? (
			<>
				<p className="text-[22px]">
					Point the camera at where {name} might be.
				</p>
				<Button className={`win95-primary ${xl}`} onClick={look}>
					<Camera aria-hidden />
					Check this picture
				</Button>
			</>
		) : (
			<>
				<p className="text-[22px]">To find {name}, I need to use the camera.</p>
				<Link
					className={buttonVariants({ variant: "ghost", className: lg })}
					data-slot="button"
					to="/hud"
				>
					Not now
				</Link>
			</>
		);
	return (
		<>
			<PictureAnswer
				best={best}
				check={check}
				familyId={familyId}
				item={item}
				live={live}
				look={look}
				name={name}
				stop={stop}
			/>
			{!live && (
				<div className="grid gap-2">
					<p className="text-[16px] text-muted-foreground">
						The camera is off. Turn it on to look again.
					</p>
					<Button className={lg} onClick={startCamera} variant="outline">
						<Camera aria-hidden />
						Turn on camera
					</Button>
				</div>
			)}
		</>
	);
}
