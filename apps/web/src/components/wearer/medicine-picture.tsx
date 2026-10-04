import type { MedicineDetection } from "@health/contracts/vision";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { ago, marker } from "./logic";
import type { CheckResult, PictureCheck } from "./medicine-check";
import { useNow } from "./use-now";

/** One box in frame pixels, and the arrow when it is the most confident one. */
function Marker({
	detection,
	frame,
	arrow,
}: {
	detection: MedicineDetection;
	frame: PictureCheck["frame"];
	arrow: boolean;
}) {
	const m = marker(detection.box, frame);
	if (m.rect.width <= 0 || m.rect.height <= 0) return null;
	const stroke = Math.max(2, frame.width / 200);
	return (
		<g>
			<rect
				{...m.rect}
				fill="none"
				opacity={0.55}
				stroke="#000"
				strokeWidth={stroke * 2}
			/>
			<rect {...m.rect} fill="none" stroke="#fff" strokeWidth={stroke} />
			{arrow && (
				<>
					<path
						d={m.arrow}
						fill="none"
						opacity={0.5}
						stroke="#000"
						strokeWidth={stroke * 2.5}
					/>
					<path
						d={m.arrow}
						fill="none"
						stroke="#fff"
						strokeWidth={stroke * 1.3}
					/>
					<polygon fill="#fff" points={m.head} />
				</>
			)}
		</g>
	);
}

/** The yellow tag on the picture: checking, the picture's age, or not checked. */
function PictureTag({
	result,
	capturedAt,
}: {
	result: CheckResult;
	capturedAt: number;
}) {
	const age = ago(useNow() - capturedAt);
	let text: ReactNode = "Picture not checked";
	if (result.kind === "looking")
		text = (
			<>
				<Loader2 aria-hidden className="size-4 animate-spin" />
				Checking this picture…
			</>
		);
	else if (result.kind === "done")
		text =
			age === "just now" ? "Picture taken just now" : `Picture from ${age}`;
	return (
		<span className="win95-raised absolute top-2 left-2 flex items-center gap-1.5 bg-[#ffffe1] px-2 py-1 text-[15px] text-black">
			{text}
		</span>
	);
}

/**
 * The checked picture in place of the live video, with marker boxes drawn in frame pixels: the
 * SVG viewBox is the frame, so the boxes scale with the picture exactly.
 */
export function CheckedPicture({
	check,
	best,
}: {
	check: PictureCheck;
	best: MedicineDetection | null;
}) {
	const detections =
		check.result.kind === "done" ? check.result.detections : [];
	return (
		<>
			<img
				alt="Camera frame that was checked"
				className="absolute inset-0 size-full bg-black object-contain"
				src={check.picture}
			/>
			<svg
				aria-hidden
				className="pointer-events-none absolute inset-0 size-full"
				preserveAspectRatio="xMidYMid meet"
				viewBox={`0 0 ${check.frame.width} ${check.frame.height}`}
			>
				{detections.map((detection) => (
					<Marker
						arrow={detection === best}
						detection={detection}
						frame={check.frame}
						key={`${detection.box.x},${detection.box.y},${detection.box.width}`}
					/>
				))}
			</svg>
			<PictureTag capturedAt={check.capturedAt} result={check.result} />
		</>
	);
}
