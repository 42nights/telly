import { Link } from "@tanstack/react-router";

import { setSessionToken } from "@/lib/session";

const links = [
	{ to: "/hud", label: "Home" },
	{ to: "/medicine", label: "Medicine" },
	{ to: "/bedtime", label: "Bedtime" },
	{ to: "/trip", label: "Going out" },
	{ to: "/family", label: "Family" },
	{ to: "/care-profile", label: "Care plan" },
	{ to: "/chat", label: "Chat" },
	{ to: "/care", label: "Care" },
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/reports", label: "Reports" },
	{ to: "/appointments", label: "Visits" },
	{ to: "/settings", label: "Settings" },
] as const;

/** The signed-in app's taskbar: one raised button per screen; the current screen shows pressed. */
export default function Header() {
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
			<button
				type="button"
				className="win95-tab ml-auto"
				onClick={() => setSessionToken(null)}
			>
				Sign out
			</button>
		</nav>
	);
}
