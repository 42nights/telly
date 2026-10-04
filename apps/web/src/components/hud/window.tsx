import { cn } from "@health/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type WindowProps = {
	title: string;
	icon: LucideIcon;
	className?: string;
	children: ReactNode;
	/** Text for the status bar under the window body. */
	status?: ReactNode;
	/**
	 * One of several parts of a screen: inside the app frame it keeps its title as a visible
	 * heading. Without it the frame's title bar names the screen, so the title is for screen
	 * readers only (index.css, "One window per page").
	 */
	group?: boolean;
};

/**
 * A Win95 window frame. Outside the app frame (sign-in, join, welcome) it has its full chrome;
 * inside it, it is a plain part of the one window. It has no minimize, maximize, or close buttons,
 * because the screens cannot do those actions and a control must not pretend.
 */
export function Window({
	title,
	icon: Icon,
	className,
	children,
	status,
	group = false,
}: WindowProps) {
	return (
		<section
			aria-label={title}
			data-group={group || undefined}
			className={cn(
				"win95-raised win95-window flex min-w-0 flex-col",
				className,
			)}
		>
			<h2 className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm">
				<Icon aria-hidden className="size-4 shrink-0" />
				{title}
			</h2>
			<div className="flex min-h-0 flex-1 flex-col p-1.5">{children}</div>
			{status !== undefined && (
				<p className="win95-inset mx-0.5 mb-0.5 px-2 py-1 text-xs">{status}</p>
			)}
		</section>
	);
}

/**
 * One screen: a window that fills the area inside the app frame with a small even gap (captain: no
 * page scroll). Content that does not fit is compacted or split into tabs, not scrolled.
 */
export function Page({ className, ...window }: WindowProps) {
	return (
		<main className="flex h-full min-h-0 p-2">
			<Window {...window} className={cn("mx-auto h-full w-full", className)} />
		</main>
	);
}
