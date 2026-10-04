import { Button } from "@health/ui/components/button";
import { useState } from "react";

/** A link shown in full with "Share link" (when the device can share) and "Copy". */
export function ShareLink({ link, title }: { link: string; title: string }) {
	const [status, setStatus] = useState<string | null>(null);
	const copy = () =>
		navigator.clipboard.writeText(link).then(
			() => setStatus("Copied."),
			() => setStatus("Could not copy. Select the link and copy it."),
		);
	const canShare = typeof navigator.share === "function";
	return (
		<div className="grid gap-2">
			<p className="win95-inset select-all break-all bg-card p-2 text-xs">
				{link}
			</p>
			{canShare && (
				<Button
					type="button"
					className="win95-primary h-11 w-full"
					onClick={() =>
						navigator
							.share(
								link.startsWith("http")
									? { title, url: link }
									: { title, text: link },
							)
							.catch(() => undefined)
					}
				>
					Share link
				</Button>
			)}
			<Button
				type="button"
				className={`${canShare ? "" : "win95-primary"}h-11 w-full`}
				onClick={() => void copy()}
			>
				Copy
			</Button>
			{status !== null && <p role="status">{status}</p>}
		</div>
	);
}
