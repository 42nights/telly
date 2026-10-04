import { X } from "lucide-react";

import { formatSize } from "./logic";

export type Attached = { readonly id: string; readonly file: File };

/** One fixed 52 px row of attached files; hidden when empty, scrolls sideways when full. */
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
			{files.map(({ id, file }) => (
				<li
					key={id}
					className="win95-inset flex h-11 max-w-56 shrink-0 items-center gap-1 pl-2 text-[13px]"
				>
					<span className="min-w-0 truncate" title={file.name}>
						{file.name}
					</span>
					<span className="shrink-0 text-muted-foreground">
						{formatSize(file.size)}
					</span>
					<button
						type="button"
						aria-label={`Remove ${file.name}`}
						title={`Remove ${file.name}`}
						className="grid size-11 shrink-0 place-items-center focus-visible:outline-dotted focus-visible:outline-2 focus-visible:outline-black focus-visible:-outline-offset-[6px]"
						onClick={() => onRemove(id)}
					>
						<X aria-hidden className="size-4" />
					</button>
				</li>
			))}
		</ul>
	);
}
