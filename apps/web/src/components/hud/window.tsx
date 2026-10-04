import { cn } from "@health/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A Win95 window frame for one HUD region. It has no minimize, maximize, or close buttons,
 * because the HUD regions cannot do those actions and a control must not pretend.
 */
export function Window({
	title,
	icon: Icon,
	className,
	children,
	status,
}: {
	title: string;
	icon: LucideIcon;
	className?: string;
	children: ReactNode;
	/** Text for the status bar under the window body. */
	status?: ReactNode;
}) {
	return (
		<section
			aria-label={title}
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
