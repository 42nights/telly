// Lock-on (#348): after Gemini finds the object, its box follows the object in the live video.
// Lost, the box stays faded while the tracker looks for it in every frame; off camera, a large
// arrow points to it from the phone's motion sensors (or to the edge where it left the frame).
// Gemini looks again only while the object is lost and should be in view, at most every 5 s.

import type { ObjectDetection } from "@health/contracts/vision";
import { Button } from "@health/ui/components/button";
import { ArrowUp, Compass } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
	edgeHint,
	guideWords,
	type Orientation,
	roomDirection,
	seenAt,
	type Vec,
} from "./guide";
import { direction, objectName } from "./logic";
import { capture, detect, type PictureCheck } from "./medicine-check";
import { Marker } from "./medicine-picture";
import {
	type Box,
	boxOf,
	follow,
	type Gray,
	lockOn,
	recheckDue,
	type Track,
	toGray,
	WORK_WIDTH,
} from "./tracker";

type Size = { readonly width: number; readonly height: number };

type View = {
	readonly frame: Size;
	/** Frame pixels; null while the object is off screen. */
	readonly box: Box | null;
	readonly state: "starting" | "locked" | "lost";
	readonly guide: { readonly angle: number; readonly words: string } | null;
};

/** Each gray pixel averages BLOCK×BLOCK drawn pixels, so camera noise averages out. */
const BLOCK = 2;

/** The tracker's gray copy of a video frame or picture of `size`; null when nothing is drawn. */
const grayOf = (
	canvas: HTMLCanvasElement,
	source: CanvasImageSource,
	size: Size,
): Gray | null => {
	const width = WORK_WIDTH * BLOCK;
	const height = Math.round((WORK_WIDTH * size.height) / size.width) * BLOCK;
	if (canvas.width !== width) canvas.width = width;
	if (canvas.height !== height) canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context === null) return null;
	context.drawImage(source, 0, 0, width, height);
	const { data } = context.getImageData(0, 0, width, height);
	return data[3] === 0 ? null : toGray(data, width, height, BLOCK);
};

/** The gray copy of a JPEG data URL from `capture`. */
const pictureGray = async (url: string, size: Size) => {
	const image = new Image();
	image.src = url;
	await image.decode();
	return grayOf(document.createElement("canvas"), image, size);
};

/** The gray copy of the video's current frame and the frame size; null while no frame shows. */
const videoGray = (canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
	if (
		video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
		video.videoWidth === 0
	)
		return null;
	const frame = { width: video.videoWidth, height: video.videoHeight };
	const gray = grayOf(canvas, video, frame);
	return gray === null ? null : { gray, frame };
};

/**
 * What a lost object's overlay shows. With motion sensors, the box where the room direction
 * meets the screen, or the arrow toward it; without them, the box where it was last seen and
 * an arrow to the edge it left through. The box is null when the object is off screen.
 */
const lostView = (
	box: Box,
	frame: Size,
	held: Orientation | null,
	room: Vec | null,
	screenAngle: number,
): View => {
	if (held === null || room === null) {
		const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		const angle = edgeHint(center, frame);
		const guide =
			angle === null ? null : { angle, words: guideWords(angle, false) };
		return { frame, box, state: "lost", guide };
	}
	const seen = seenAt(room, held, frame, screenAngle);
	if (seen.kind === "in") {
		const at = { x: seen.x - box.width / 2, y: seen.y - box.height / 2 };
		return { frame, box: { ...box, ...at }, state: "lost", guide: null };
	}
	const words = guideWords(seen.angle, seen.behind);
	return {
		frame,
		box: null,
		state: "lost",
		guide: { angle: seen.angle, words },
	};
};

// Safari's `DeviceOrientationEvent.requestPermission` is not in TypeScript's DOM types.
const motion = globalThis.DeviceOrientationEvent as unknown as
	| { requestPermission?: () => Promise<string> }
	| undefined;

/**
 * The phone's latest orientation, without re-rendering. iPhone gives motion events only after
 * a tap allows them: `ask` holds on a touch screen until that tap or the first event.
 */
function useOrientation() {
	const latest = useRef<Orientation | null>(null);
	const [ask, setAsk] = useState(
		() =>
			typeof motion?.requestPermission === "function" &&
			matchMedia("(pointer: coarse)").matches,
	);
	useEffect(() => {
		const on = ({ alpha, beta, gamma }: DeviceOrientationEvent) => {
			if (alpha === null || beta === null || gamma === null) return;
			latest.current = { alpha, beta, gamma };
			setAsk(false);
		};
		window.addEventListener("deviceorientation", on);
		return () => window.removeEventListener("deviceorientation", on);
	}, []);
	const allow = () => {
		setAsk(false);
		void motion?.requestPermission?.().catch(() => undefined);
	};
	return { latest, ask, allow };
}

/**
 * The live marker over the camera video: the found box follows the object frame by frame.
 * `onWay` gets the direction in words whenever it changes, for the answer column and speech.
 */
export function LockOn({
	check,
	best,
	familyId,
	video,
	onWay,
}: {
	check: PictureCheck;
	best: ObjectDetection;
	familyId: string | null;
	video: RefObject<HTMLVideoElement | null>;
	onWay: (way: string) => void;
}) {
	const name = `your ${objectName(best.category, best.label)}`;
	const [view, setView] = useState<View>({
		frame: check.frame,
		box: best.box,
		state: "starting",
		guide: null,
	});
	const orientation = useOrientation();
	const latest = orientation.latest;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the parent keys this per check and object.
	useEffect(() => {
		let stopped = false;
		let frameId = 0;
		const controller = new AbortController();
		const canvas = document.createElement("canvas");
		let track: Track | null = null;
		let lastTime = -1;
		/** The object's direction in the room, from the last locked frame. */
		let room: Vec | null = null;
		let lostAt: number | null = null;
		let recheckAt: number | null = null;
		let rechecking = false;
		let said = "";

		const toGrayBox = (box: Box, frame: Size): Box => {
			const k = WORK_WIDTH / frame.width;
			return {
				x: box.x * k,
				y: box.y * k,
				width: box.width * k,
				height: box.height * k,
			};
		};

		const show = (next: View) => {
			setView(next);
			const way =
				next.state === "locked" && next.box !== null
					? direction(next.box, next.frame)
					: next.guide !== null
						? `${next.guide.words}.`
						: `Looking for ${name}…`;
			if (next.state !== "starting" && way !== said) {
				said = way;
				onWay(way);
			}
		};

		const recheck = (v: HTMLVideoElement) => {
			const frame = capture(v);
			if (familyId === null || frame === null) return;
			rechecking = true;
			recheckAt = Date.now();
			void detect(familyId, frame, controller.signal)
				.then(async (result) => {
					if (result.kind !== "done") return;
					const match = result.detections
						.filter((d) => d.category === best.category)
						.sort((a, b) => b.confidence - a.confidence)[0];
					if (match === undefined) return;
					const gray = await pictureGray(frame.picture, frame);
					if (gray === null || stopped) return;
					track = lockOn(gray, toGrayBox(match.box, frame));
					lostAt = null;
				})
				.catch(() => undefined)
				.finally(() => {
					rechecking = false;
				});
		};

		const step = () => {
			if (stopped) return;
			frameId = requestAnimationFrame(step);
			const v = video.current;
			if (track === null || v === null || v.currentTime === lastTime) return;
			const read = videoGray(canvas, v);
			if (read === null) return;
			lastTime = v.currentTime;
			const { gray, frame } = read;
			track = follow(track, gray);
			const k = frame.width / WORK_WIDTH;
			const g = boxOf(track);
			const box = {
				x: g.x * k,
				y: g.y * k,
				width: g.width * k,
				height: g.height * k,
			};
			const held = latest.current;
			const screenAngle = screen.orientation?.angle ?? 0;
			if (track.locked) {
				lostAt = null;
				const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
				room =
					held === null
						? null
						: roomDirection(held, center, frame, screenAngle);
				return show({ frame, box, state: "locked", guide: null });
			}
			lostAt ??= Date.now();
			const lost = lostView(box, frame, held, room, screenAngle);
			show(lost);
			const now = Date.now();
			const inView = lost.box !== null;
			if (!rechecking && recheckDue({ lostAt, inView, lastAt: recheckAt, now }))
				recheck(v);
		};

		void pictureGray(check.picture, check.frame)
			.then((gray) => {
				if (gray === null || stopped) return;
				track = lockOn(gray, toGrayBox(best.box, check.frame));
			})
			.catch(() => undefined);
		frameId = requestAnimationFrame(step);
		return () => {
			stopped = true;
			cancelAnimationFrame(frameId);
			controller.abort();
		};
	}, []);

	const tag =
		view.state === "starting"
			? "Locking on…"
			: view.state === "locked"
				? "✓ Locked on"
				: `Looking for ${name}…${view.guide === null ? "" : ` ${view.guide.words}`}`;
	return (
		<>
			<svg
				aria-hidden
				className="pointer-events-none absolute inset-0 size-full"
				preserveAspectRatio="xMidYMid meet"
				viewBox={`0 0 ${view.frame.width} ${view.frame.height}`}
			>
				{view.box !== null && (
					<g opacity={view.state === "locked" ? 1 : 0.45}>
						<Marker
							arrow={view.state === "locked"}
							detection={{ ...best, box: view.box }}
							frame={view.frame}
						/>
					</g>
				)}
			</svg>
			{view.guide !== null && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 grid place-items-center"
				>
					<ArrowUp
						className="size-32 text-[#ffd400] drop-shadow-[0_0_3px_#000]"
						strokeWidth={3}
						style={{
							transform: `rotate(${view.guide.angle + Math.PI / 2}rad)`,
						}}
					/>
				</div>
			)}
			<span className="win95-raised absolute top-2 left-2 bg-[#ffffe1] px-2 py-1 text-[15px] text-black">
				{tag}
			</span>
			{orientation.ask && (
				<Button
					className="absolute top-12 left-2 h-12 text-[16px]"
					onClick={orientation.allow}
				>
					<Compass aria-hidden />
					Guide me with phone motion
				</Button>
			)}
		</>
	);
}
