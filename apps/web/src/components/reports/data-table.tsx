import type { ReactNode } from "react";

/** A sunken, scrolling table with a fixed maximum height. `children` are the body rows. */
export function DataTable({
	headers,
	children,
}: {
	headers: readonly string[];
	children: ReactNode;
}) {
	return (
		<div className="win95-inset max-h-72 overflow-auto bg-card">
			<table className="w-full text-left text-sm">
				<thead>
					<tr>
						{headers.map((header) => (
							<th key={header} className="p-1.5">
								{header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
