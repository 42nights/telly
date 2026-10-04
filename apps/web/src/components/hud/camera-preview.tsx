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
import { type ReactNode, useEffect, useRef, useState } from "react";

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

/** Set once the camera ran on this device, so later visits start it without a tap. */
const ALLOWED_KEY = "telly.camera.allowed";
/** A lost feed or a passing failure opens the camera again this many times, this far apart. */
const RETRIES = 3;
const RETRY_MS = 1_500;

const restartable = (state: CameraState) =>
	state.kind === "lost" ||
	(state.kind === "failed" &&
		(state.reason === "busy" || state.reason === "error"));

/** True when the browser says the camera is allowed. Safari before 16 cannot tell. */
const browserAllowsCamera = () =>
	// "camera" is missing from TypeScript's PermissionName.
	(
		navigator.permissions?.query({ name: "camera" as PermissionName }) ??
		Promise.reject()
	)
		.then((permission) => permission.state === "granted")
		.catch(() => false);

/**
 * While the camera is `on`, opens it again (`reopen`) after a lost feed or a passing failure,
 * `RETRIES` times until it runs, and whenever the page comes back with the camera stopped.
 */
function useReopen(
	state: CameraState,
	on: boolean,
	reopen: () => void,
	retries: { current: number },
) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: `reopen` and `retries` are stable in effect; a re-render must not restart the wait.
	useEffect(() => {
		if (!on || !restartable(state) || retries.current >= RETRIES) return;
		const timer = setTimeout(() => {
			retries.current++;
			reopen();
		}, RETRY_MS);
		return () => clearTimeout(timer);
	}, [state, on]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `reopen` and `retries` are stable in effect.
	useEffect(() => {
		if (!on) return;
		const back = () => {
			if (document.visibilityState !== "visible") return;
			// iPhone can end the tracks of a backgrounded page without an `ended` event.
			const ended =
				state.kind === "live" &&
				state.stream.getTracks().some((t) => t.readyState === "ended");
			if (!ended && !restartable(state)) return;
			retries.current = 0;
			reopen();
		};
		document.addEventListener("visibilitychange", back);
		return () => document.removeEventListener("visibilitychange", back);
	}, [state, on]);
}

/**
 * The camera's state and controls. With `autoStart`, a device that allowed the camera before
 * (stored here, or by the browser's permission) starts it on mount; a first visit shows the
 * start button. A feed the browser ended, or a passing failure, opens again by itself, and so
 * does a camera that stopped while the page or app was in the background.
 */
export function useCamera(autoStart = false): CameraControl {
	const [state, setState] = useState<CameraState>({ kind: "off" });
	// 0 = camera off; each start or retry increments it, so the effect reopens the camera.
	const [session, setSession] = useState(() =>
		autoStart && localStorage.getItem(ALLOWED_KEY) === "1" ? 1 : 0,
	);
	const retries = useRef(0);
	const start = () => setSession((n) => n + 1);

	// biome-ignore lint/correctness/useExhaustiveDependencies: asks once, on mount.
	useEffect(() => {
		if (!autoStart || session !== 0) return;
		let cancelled = false;
		void browserAllowsCamera().then((allowed) => {
			if (allowed && !cancelled) setSession((n) => n || 1);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Cleanup stops every track on stop, retry, route exit, and unmount.
	useEffect(
		() =>
			session === 0
				? undefined
				: openCamera(navigator.mediaDevices, (next) => {
						if (next.kind === "live") {
							localStorage.setItem(ALLOWED_KEY, "1");
							retries.current = 0;
						}
						if (next.kind === "failed" && next.reason === "denied")
							localStorage.removeItem(ALLOWED_KEY);
						setState(next);
					}),
		[session],
	);
	useReopen(state, session !== 0, start, retries);

	return {
		state,
		start,
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
