import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
	getSessionToken,
	onSessionChange,
	setSessionToken,
} from "@/lib/session";

const links = [
	{ to: "/hud", label: "Home" },
	{ to: "/medicine", label: "Medicine" },
	{ to: "/family", label: "Family" },
	{ to: "/care-profile", label: "Care plan" },
	{ to: "/chat", label: "Chat" },
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/reports", label: "Reports" },
	{ to: "/settings", label: "Settings" },
] as const;

/** The app's taskbar: one raised button per screen; the current screen shows pressed. */
export default function Header() {
	const [signedIn, setSignedIn] = useState(() => getSessionToken() !== null);
	useEffect(
		() => onSessionChange(() => setSignedIn(getSessionToken() !== null)),
		[],
	);
	return (
		<nav
			aria-label="Screens"
			className="win95-raised flex gap-1 overflow-x-auto p-1.5"
		>
			{links.map(({ to, label }) => (
				<Link
					key={to}
					to={to}
					className="win95-tab"
					activeProps={{ "aria-current": "page" }}
				>
					{label}
				</Link>
			))}
			{signedIn ? (
				<button
					type="button"
					className="win95-tab ml-auto"
					onClick={() => setSessionToken(null)}
				>
					Sign out
				</button>
			) : (
				<Link
					to="/sign-in"
					className="win95-tab ml-auto"
					activeProps={{ "aria-current": "page" }}
				>
					Sign in
				</Link>
			)}
		</nav>
	);
}
