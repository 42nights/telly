import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
	getSessionToken,
	onSessionChange,
	setSessionToken,
} from "@/lib/session";

const closeMore = () => document.getElementById("more")?.hidePopover();

const links = [
	{ to: "/hud", label: "Home" },
	{ to: "/medicine", label: "Medicine" },
	{ to: "/family", label: "Family" },
	{ to: "/chat", label: "Chat" },
	{ to: "/reports", label: "Reports" },
] as const;

const more = [
	{ to: "/bedtime", label: "Bedtime" },
	{ to: "/trip", label: "Going out" },
	{ to: "/care-profile", label: "Care plan" },
	{ to: "/care", label: "Care" },
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/appointments", label: "Visits" },
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
			<button type="button" popoverTarget="more" className="win95-tab ml-auto">
				More
			</button>
			<div
				id="more"
				popover="auto"
				className="win95-raised fixed inset-auto top-14 right-1.5 m-0 flex-col gap-1 border-0 p-1.5 open:flex"
			>
				{more.map(({ to, label }) => (
					<Link
						key={to}
						to={to}
						className="win95-tab"
						activeProps={{ "aria-current": "page" }}
						onClick={closeMore}
					>
						{label}
					</Link>
				))}
				{signedIn ? (
					<button
						type="button"
						className="win95-tab"
						onClick={() => {
							setSessionToken(null);
							closeMore();
						}}
					>
						Sign out
					</button>
				) : (
					<Link
						to="/sign-in"
						className="win95-tab"
						activeProps={{ "aria-current": "page" }}
						onClick={closeMore}
					>
						Sign in
					</Link>
				)}
			</div>
		</nav>
	);
}
