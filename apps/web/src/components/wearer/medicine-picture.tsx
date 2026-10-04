import type { MedicineDetection } from "@health/contracts/vision";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { ago, marker } from "./logic";
import type { CheckResult, PictureCheck } from "./medicine-check";
import { useNow } from "./use-now";

const SURE = "#fff";
const UNSURE = "#ffd400";

/** The tag text: an icon character plus words, so the marker never relies on color alone. */
const tagText = ({ label, needsVerification }: MedicineDetection) => {
	const name =
		label !== null && label.length > 24 ? `${label.slice(0, 23)}…` : label;
	if (!needsVerification) return `✓ ${name ?? "Medicine box"}`;
	return name === null ? "? Check the label" : `? ${name} · check label`;
};

/**
 * One box in frame pixels with a tag, and the arrow when it is the most confident one. A box that
 * needs a label check is yellow and dashed and its tag starts with "?"; a sure one is white with "✓".
 */
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
	const color = detection.needsVerification ? UNSURE : SURE;
	const text = tagText(detection);
	// About 1/20 of the frame width: ≈16 px on a phone-width picture.
	const size = Math.max(14, frame.width / 20);
	// Above the box when it fits and the arrow does not come from there, else below; inside the frame.
	const above = m.rect.y >= size * 1.6 && !(arrow && m.fromTop);
	const tagY = above
		? m.rect.y - size * 0.5
		: Math.min(
				m.rect.y + m.rect.height + size * 1.2,
				frame.height - size * 0.3,
			);
	const tagX = Math.max(
		0,
		Math.min(m.rect.x, frame.width - text.length * size * 0.6),
	);
	return (
		<g>
			<rect
				{...m.rect}
				fill="none"
				opacity={0.55}
				stroke="#000"
				strokeWidth={stroke * 2}
			/>
			<rect
				{...m.rect}
				fill="none"
				stroke={color}
				strokeDasharray={
					detection.needsVerification
						? `${stroke * 4} ${stroke * 2}`
						: undefined
				}
				strokeWidth={stroke}
			/>
			<text
				fill={color}
				fontSize={size}
				fontWeight="bold"
				paintOrder="stroke"
				stroke="#000"
				strokeLinejoin="round"
				strokeWidth={size * 0.25}
				x={tagX}
				y={tagY}
			>
				{text}
			</text>
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
						stroke={color}
						strokeWidth={stroke * 1.3}
					/>
					<polygon fill={color} points={m.head} />
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
			{/* Before the markers, so a marker's ✓/? tag stays on top where they overlap. */}
			<PictureTag capturedAt={check.capturedAt} result={check.result} />
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
		</>
	);
}
