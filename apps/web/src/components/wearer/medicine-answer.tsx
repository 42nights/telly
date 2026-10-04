import type { ObjectDetection } from "@health/contracts/vision";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Camera, CloudOff, Info, Save, Square, Volume2, X } from "lucide-react";
import type { ReactNode } from "react";

import type { ApiFailure } from "@/lib/api";
import { signInConfig } from "@/lib/sign-in";

import { direction, objectName } from "./logic";
import type { Choice, PictureCheck } from "./medicine-check";
import { SpeechLine, useSpeech } from "./speech";

const xl = "h-16 w-full text-[22px] [&_svg]:size-7";
const lg = "h-14 w-full text-[20px] [&_svg]:size-6";

const failureText: Record<ApiFailure["kind"], string> = {
	signed_out:
		signInConfig() === null
			? "Sign in to check pictures. Sign-in is not set up on this server."
			: "Sign in to check pictures.",
	forbidden: "You can't check pictures for this person.",
	unavailable: "The picture checker is not available right now.",
	error: "Something went wrong while checking the picture.",
};

type Look = () => void;

/** "Looks like: your keys". Medicine says what its label reads, or that it could not read it. */
const looksLike = (best: ObjectDetection) =>
	best.category !== "medicine"
		? `your ${objectName(best.category, best.label)}`
		: best.label === null
			? "medicine. I can't read the label"
			: `medicine. The label looks like “${best.label}”`;

function Found({
	check,
	best,
	way: liveWay,
	familyId,
	live,
	look,
	choice,
}: {
	check: PictureCheck;
	best: ObjectDetection;
	way: string | null;
	familyId: string | null;
	live: boolean;
	look: Look;
	choice: Choice;
}) {
	const { speech, say } = useSpeech(familyId);
	const medicine = best.category === "medicine";
	const way = liveWay ?? direction(best.box, check.frame);
	const unsure = best.needsVerification
		? medicine
			? "I'm not sure about this one. Look closely at the label."
			: "I'm not sure about this one. Check that it is yours."
		: "";
	const labelRule = medicine
		? "Check the label on the box before you take anything."
		: "";
	const spoken = [`Looks like ${looksLike(best)}.`, way, unsure, labelRule]
		.filter(Boolean)
		.join(" ");
	const saidThis = speech.key === `${check.id}:${choice.skipped}`;
	return (
		<>
			<p className="break-words text-[22px]">
				Looks like: <b>{looksLike(best)}</b>
			</p>
			<p className="font-semibold">{way}</p>
			{unsure !== "" && <p className="font-semibold">{unsure}</p>}
			{medicine && (
				<p className="win95-raised flex items-start gap-3 p-4 text-[18px]">
					<Info aria-hidden className="mt-0.5 size-6 shrink-0" />
					{labelRule}
				</p>
			)}
			<div className="grid gap-2 sm:grid-cols-2">
				<Button className={`win95-primary ${xl}`} onClick={choice.save}>
					<Save aria-hidden />
					Save
				</Button>
				<Button className={xl} onClick={choice.notThis} variant="outline">
					<X aria-hidden />
					Not this
				</Button>
			</div>
			<Button
				className={lg}
				disabled={speech.kind === "loading"}
				onClick={() => void say(`${check.id}:${choice.skipped}`, spoken)}
				variant="outline"
			>
				<Volume2 aria-hidden />
				{saidThis ? "Say it again" : "Read it aloud"}
			</Button>
			{saidThis && <SpeechLine speech={speech} />}
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
	way,
	name,
	familyId,
	live,
	look,
	stop,
	choice,
}: {
	check: PictureCheck;
	best: ObjectDetection | null;
	way: string | null;
	name: ReactNode;
	familyId: string | null;
	live: boolean;
	look: Look;
	stop: () => void;
	choice: Choice;
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
	if (result.kind !== "done")
		return <CheckFailed failure={result} live={live} look={look} />;
	if (best !== null)
		return (
			<Found
				best={best}
				check={check}
				choice={choice}
				familyId={familyId}
				live={live}
				look={look}
				way={way}
			/>
		);
	return (
		<>
			{choice.skipped > 0 ? (
				<p className="text-[22px]">That was everything I found here.</p>
			) : (
				<p className="text-[22px]">
					I could not see anything to save. Try again.
				</p>
			)}
			<p className="text-[18px] text-muted-foreground">
				Point the camera at {name} on a counter or shelf.
			</p>
			<Button className={`win95-primary ${xl}`} disabled={!live} onClick={look}>
				<Camera aria-hidden />
				Look again
			</Button>
		</>
	);
}

/**
 * The answer column: what the wearer can do for the camera and the current picture check. `way`
 * is the lock-on's live direction to the found object; null uses the checked picture's.
 */
export function ObjectAnswer({
	check,
	best,
	way = null,
	name,
	familyId,
	live,
	look,
	stop,
	startCamera,
	choice,
}: {
	check: PictureCheck | null;
	best: ObjectDetection | null;
	way?: string | null;
	name: ReactNode;
	familyId: string | null;
	live: boolean;
	look: Look;
	stop: () => void;
	startCamera: () => void;
	choice: Choice;
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
				choice={choice}
				familyId={familyId}
				live={live}
				look={look}
				name={name}
				stop={stop}
				way={way}
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
