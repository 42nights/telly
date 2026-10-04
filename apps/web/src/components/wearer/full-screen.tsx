// The finder over the whole screen (#378, #383): on a phone it always is; on a desktop the Full
// screen button makes it so. The finder's own element covers the app frame, so the lock-on box, the
// guide, and the controls stay on the camera. Where the browser has the Fullscreen API (desktop,
// Android), the same element also goes browser full screen. The iPhone's video-only full screen is
// never used: it shows the bare video without the overlays.
import { Button } from "@health/ui/components/button";
import { Maximize, Minimize } from "lucide-react";
import { type TouchEvent, useEffect, useRef, useState } from "react";

/** A downward swipe this long (px), and mostly vertical, leaves full screen. */
const SWIPE_DOWN = 80;
/** The finder's phone layout: below Tailwind's `md`. */
const PHONE = "(max-width: 767px)";

/** True on a phone-sized screen, following rotation and resizes. */
export function usePhone() {
	const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
	useEffect(() => {
		const query = matchMedia(PHONE);
		const change = () => setPhone(query.matches);
		query.addEventListener("change", change);
		return () => query.removeEventListener("change", change);
	}, []);
	return phone;
}

/**
 * Desktop full screen for one element: spread `frame` on it, `toggle` enters or leaves, and
 * Escape or a swipe down leaves. The element stays mounted, so the camera keeps running.
 */
export function useFullScreen<T extends HTMLElement>() {
	const ref = useRef<T | null>(null);
	const [full, setFull] = useState(false);
	const start = useRef<{ x: number; y: number } | null>(null);

	const leave = () => {
		setFull(false);
		if (document.fullscreenElement)
			void document.exitFullscreen().catch(() => undefined);
	};

	useEffect(() => {
		if (!full) return;
		const key = (event: KeyboardEvent) => event.key === "Escape" && leave();
		// The browser's own exit (Escape, its exit gesture) ends the overlay too.
		const change = () => document.fullscreenElement || setFull(false);
		window.addEventListener("keydown", key);
		document.addEventListener("fullscreenchange", change);
		return () => {
			window.removeEventListener("keydown", key);
			document.removeEventListener("fullscreenchange", change);
		};
	});

	return {
		full,
		toggle: () => {
			if (full) return leave();
			setFull(true);
			// Optional: a browser without the API keeps the CSS overlay only.
			void ref.current?.requestFullscreen?.().catch(() => undefined);
		},
		frame: {
			ref,
			onTouchStart: (event: TouchEvent) => {
				const touch = event.touches[0];
				start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
			},
			onTouchEnd: (event: TouchEvent) => {
				const from = start.current;
				const touch = event.changedTouches[0];
				start.current = null;
				if (!full || from === null || touch === undefined) return;
				const dy = touch.clientY - from.y;
				if (dy > SWIPE_DOWN && dy > 2 * Math.abs(touch.clientX - from.x))
					leave();
			},
		},
	};
}

/** The toggle in the camera's top-right corner. */
export function FullScreenButton({
	full,
	toggle,
}: {
	full: boolean;
	toggle: () => void;
}) {
	const label = full ? "Exit full screen" : "Full screen";
	return (
		<Button
			aria-label={label}
			className="absolute top-2 right-2 z-10 size-12 [&_svg]:size-6"
			onClick={toggle}
			title={label}
		>
			{full ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
		</Button>
	);
}
