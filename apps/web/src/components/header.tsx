import { Link } from "@tanstack/react-router";

const links = [
	{ to: "/hud", label: "Home" },
	{ to: "/medicine", label: "Medicine" },
	{ to: "/family", label: "Family" },
	{ to: "/chat", label: "Chat" },
	{ to: "/care", label: "Care" },
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/reports", label: "Reports" },
	{ to: "/settings", label: "Settings" },
] as const;

/** The app's taskbar: one raised button per screen; the current screen shows pressed. */
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
		</nav>
	);
}
