import { X } from "lucide-react";

import { type Attached, formatSize } from "./logic";

/** The 44 px × button that removes a file or cancels a reply. */
export const X_BUTTON =
	"grid size-11 shrink-0 place-items-center focus-visible:outline-dotted focus-visible:outline-2 focus-visible:outline-black focus-visible:-outline-offset-[6px]";

/**
 * One fixed 52 px row of attached files; hidden when empty, scrolls sideways when full. A file that
 * cannot be sent shows why and stays out of the question.
 */
export function FileTray({
	files,
	onRemove,
}: {
	files: readonly Attached[];
	onRemove: (id: string) => void;
}) {
	if (files.length === 0) return null;
	return (
		<ul
			aria-label="Attached files"
			className="flex h-[52px] shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
		>
			<li className="shrink-0 px-1 font-bold text-[13px]">
				{files.length} {files.length === 1 ? "file" : "files"}
			</li>
			{files.map(({ id, file, error }) => (
				<li
					key={id}
					className="win95-inset flex h-11 max-w-80 shrink-0 items-center gap-1 pl-2 text-[13px]"
				>
					<span className="min-w-12 truncate" title={file.name}>
						{file.name}
					</span>
					{error === null ? (
						<span className="shrink-0 text-muted-foreground">
							{formatSize(file.size)}
						</span>
					) : (
						<span className="shrink-0 font-bold text-destructive">
							Not sent: {error}
						</span>
					)}
					<button
						type="button"
						aria-label={`Remove ${file.name}`}
						title={`Remove ${file.name}`}
						className={X_BUTTON}
						onClick={() => onRemove(id)}
					>
						<X aria-hidden className="size-4" />
					</button>
				</li>
			))}
		</ul>
	);
}
