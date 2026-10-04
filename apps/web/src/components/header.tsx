import { Link, useLocation } from "@tanstack/react-router";
import {
	CalendarDays,
	Ellipsis,
	FileText,
	Footprints,
	HeartHandshake,
	House,
	LogOut,
	MessageCircle,
	Moon,
	Pill,
	Settings,
	Users,
} from "lucide-react";
import { useRef } from "react";

import { setSessionToken } from "@/lib/session";

// Five screens stay on the bar so it fits one row on a 390 px phone (#209); the rest open from More.
const barLinks = [
	{ to: "/hud", label: "Home", icon: House },
	{ to: "/medicine", label: "Medicine", icon: Pill },
	{ to: "/family", label: "Family", icon: Users },
	{ to: "/chat", label: "Chat", icon: MessageCircle },
	{ to: "/reports", label: "Reports", icon: FileText },
] as const;

const moreLinks = [
	{ to: "/bedtime", label: "Bedtime", icon: Moon },
	{ to: "/trip", label: "Going out", icon: Footprints },
	{ to: "/care-profile", label: "Care plan", icon: HeartHandshake },
	{ to: "/appointments", label: "Visits", icon: CalendarDays },
	{ to: "/settings", label: "Settings", icon: Settings },
] as const;

/** True when the current screen is one of the More menu's, so the More button shows pressed. */
export const inMoreMenu = (pathname: string) =>
	moreLinks.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

const MENU_WIDTH = 192; // w-48
const menuItem =
	"flex min-h-11 items-center gap-2 px-3 text-sm hover:bg-primary hover:text-primary-foreground focus-visible:bg-primary focus-visible:text-primary-foreground focus-visible:outline-none aria-[current=page]:font-bold";

/** The signed-in app's taskbar: one raised button per screen; the current screen shows pressed. */
export default function Header() {
	const moreActive = useLocation({
		select: (location) => inMoreMenu(location.pathname),
	});
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const close = () => menu.current?.hidePopover();
	return (
		<nav
			aria-label="Screens"
			className="win95-raised win95-taskbar flex gap-1 p-1.5"
		>
			{barLinks.map(({ to, label, icon: Icon }) => (
				<Link
					key={to}
					to={to}
					className="win95-tab"
					activeProps={{ "aria-current": "page" }}
				>
					<Icon aria-hidden />
					{label}
				</Link>
			))}
			<button
				ref={button}
				type="button"
				popoverTarget="more-screens"
				className="win95-tab"
				data-current={moreActive || undefined}
			>
				<Ellipsis aria-hidden />
				More
			</button>
			{/* A native popover: Escape and a tap outside close it, and focus returns to More. */}
			<div
				ref={menu}
				id="more-screens"
				popover="auto"
				className="win95-raised inset-auto m-0 w-48 border-0 p-1 text-foreground"
				onBeforeToggle={(event) => {
					const rect = button.current?.getBoundingClientRect();
					if (event.newState !== "open" || rect === undefined) return;
					event.currentTarget.style.top = `${rect.bottom}px`;
					event.currentTarget.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 4))}px`;
				}}
			>
				<ul className="grid">
					{moreLinks.map(({ to, label, icon: Icon }) => (
						<li key={to}>
							<Link
								to={to}
								className={menuItem}
								onClick={close}
								activeProps={{ "aria-current": "page" }}
							>
								<Icon aria-hidden className="size-4" />
								{label}
							</Link>
						</li>
					))}
					<li
						aria-hidden
						className="mx-1 my-1 border-t border-t-[var(--win95-shadow)] border-b border-b-[var(--win95-highlight)]"
					/>
					<li>
						<button
							type="button"
							className={`${menuItem} w-full`}
							onClick={() => {
								close();
								setSessionToken(null);
							}}
						>
							<LogOut aria-hidden className="size-4" />
							Sign out
						</button>
					</li>
				</ul>
			</div>
		</nav>
	);
}
