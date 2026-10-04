import { Button } from "@health/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@health/ui/components/empty";
import { Camera, CameraOff } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { type CameraFailure, type CameraState, openCamera } from "./camera";

type Idle = "off" | "starting" | "lost" | CameraFailure;

/** What the camera region says when no live video shows. `problem` marks a failure to announce. */
const idleText: Record<
	Idle,
	{ title: string; description: string; problem: boolean }
> = {
	off: {
		title: "Camera is off",
		description:
			"Use this device's camera to see the scene. Glasses are not needed.",
		problem: false,
	},
	starting: {
		title: "Waiting for camera permission…",
		description: "Allow camera access in the browser prompt.",
		problem: false,
	},
	lost: {
		title: "Camera stopped",
		description:
			"The browser ended the camera feed. The camera may be disconnected or its permission removed.",
		problem: true,
	},
	denied: {
		title: "Camera permission denied",
		description:
			"Allow camera access for this site in the browser settings, then try again.",
		problem: true,
	},
	"no-camera": {
		title: "No camera found",
		description: "Connect a camera or open the HUD on a phone, then try again.",
		problem: true,
	},
	busy: {
		title: "Camera could not start",
		description:
			"Another app may be using the camera. Close it, then try again.",
		problem: true,
	},
	unsupported: {
		title: "Camera unavailable in this browser",
		description:
			"The browser allows the camera only on HTTPS or localhost. Open the HUD on a secure address.",
		problem: true,
	},
	error: {
		title: "Camera failed to start",
		description: "Try again. If it fails again, reload the page.",
		problem: true,
	},
};

export type CameraControl = {
	readonly state: CameraState;
	readonly start: () => void;
	readonly stop: () => void;
};

/** The camera's state and controls. `autoStart` asks for the camera on mount. */
export function useCamera(autoStart = false): CameraControl {
	const [state, setState] = useState<CameraState>({ kind: "off" });
	// 0 = camera off; each start or retry increments it, so the effect reopens the camera.
	const [session, setSession] = useState(autoStart ? 1 : 0);

	// Cleanup stops every track on stop, retry, route exit, and unmount.
	useEffect(
		() =>
			session === 0 ? undefined : openCamera(navigator.mediaDevices, setState),
		[session],
	);
	return {
		state,
		start: () => setSession((n) => n + 1),
		stop: () => {
			setSession(0);
			setState({ kind: "off" });
		},
	};
}

/**
 * The live camera scene. `onVideo` receives the video element once it shows a frame, so a caller
 * can capture it; `children` are extra controls next to "Stop camera".
 */
export function CameraPreview({
	camera: { state, start, stop },
	onVideo,
	children,
}: {
	camera: CameraControl;
	onVideo?: (video: HTMLVideoElement) => void;
	children?: ReactNode;
}) {
	if (state.kind === "live")
		return (
			<>
				<video
					aria-label="Live camera preview"
					autoPlay
					className="absolute inset-0 size-full bg-black object-contain"
					muted
					onLoadedData={(event) => {
						// For a camera stream, `loadeddata` can fire before any frame is painted, and a
						// capture then reads a blank image. Wait for the first presented frame.
						const video = event.currentTarget;
						video.requestVideoFrameCallback(() => onVideo?.(video));
					}}
					playsInline
					ref={(video) => {
						if (video && video.srcObject !== state.stream)
							video.srcObject = state.stream;
					}}
				/>
				<div className="absolute inset-x-2 bottom-2 flex flex-wrap items-end justify-end gap-2">
					{children}
					<Button onClick={stop}>
						<CameraOff aria-hidden />
						Stop camera
					</Button>
				</div>
			</>
		);

	const text = idleText[state.kind === "failed" ? state.reason : state.kind];
	return (
		<Empty className="absolute inset-0 overflow-y-auto">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					{text.problem ? <CameraOff /> : <Camera />}
				</EmptyMedia>
				<EmptyTitle className="text-base">{text.title}</EmptyTitle>
				<EmptyDescription role={text.problem ? "alert" : undefined}>
					{text.description}
				</EmptyDescription>
			</EmptyHeader>
			{state.kind !== "starting" && (
				<EmptyContent>
					<Button
						className="win95-primary h-14 px-5 text-[18px]"
						onClick={start}
					>
						<Camera aria-hidden />
						{state.kind === "off" ? "Turn on camera" : "Try again"}
					</Button>
				</EmptyContent>
			)}
		</Empty>
	);
}
