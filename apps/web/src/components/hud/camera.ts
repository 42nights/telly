export type CameraFailure =
	| "denied"
	| "no-camera"
	| "busy"
	| "unsupported"
	| "error";

export type CameraState =
	| { readonly kind: "off" }
	| { readonly kind: "starting" }
	| { readonly kind: "live"; readonly stream: MediaStream }
	/** The browser ended capture: camera unplugged, permission revoked, or the OS took it. */
	| { readonly kind: "lost" }
	| {
			readonly kind: "failed";
			readonly reason: CameraFailure;
			readonly message: string;
	  };

const failure = (error: unknown): CameraState => {
	const name = error instanceof Error ? error.name : "";
	const reason: CameraFailure =
		name === "NotAllowedError" || name === "SecurityError"
			? "denied"
			: name === "NotFoundError" || name === "OverconstrainedError"
				? "no-camera"
				: name === "NotReadableError" || name === "AbortError"
					? "busy"
					: "error";
	return { kind: "failed", reason, message: String(error) };
};

/**
 * Opens the camera (rear camera preferred, any camera accepted) and reports each state change.
 * Returns stop, which releases every track, including a stream granted after stop was called,
 * so a React effect can be `useEffect(() => openCamera(navigator.mediaDevices, setState), [])`.
 * `media` is undefined outside a secure context (HTTPS or localhost).
 */
export const openCamera = (
	media: Pick<MediaDevices, "getUserMedia"> | undefined,
	onState: (state: CameraState) => void,
): (() => void) => {
	let stream: MediaStream | undefined;
	let stopped = false;
	const stop = () => {
		stopped = true;
		for (const track of stream?.getTracks() ?? []) track.stop();
	};
	if (media?.getUserMedia === undefined) {
		onState({
			kind: "failed",
			reason: "unsupported",
			message: "navigator.mediaDevices is unavailable",
		});
		return stop;
	}
	onState({ kind: "starting" });
	media
		.getUserMedia({ video: { facingMode: "environment" }, audio: false })
		.then(
			(granted) => {
				stream = granted;
				if (stopped) return stop();
				for (const track of granted.getTracks())
					track.addEventListener("ended", () => {
						if (stopped) return;
						stop();
						onState({ kind: "lost" });
					});
				onState({ kind: "live", stream: granted });
			},
			(error: unknown) => {
				if (!stopped) onState(failure(error));
			},
		);
	return stop;
};
