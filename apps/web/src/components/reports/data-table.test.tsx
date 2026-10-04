import "../test/setup";

import { describe, expect, test } from "bun:test";
import { installDom, render } from "../test/dom";

import { DataTable } from "./data-table";

installDom();

describe("DataTable", () => {
	test("shows each header as a column and the rows as the body", () => {
		const view = render(
			<DataTable headers={["Test", "Value"]}>
				<tr>
					<td>LDL</td>
					<td>120</td>
				</tr>
			</DataTable>,
		);
		expect(
			view.getAllByRole("columnheader").map((cell) => cell.textContent),
		).toEqual(["Test", "Value"]);
		expect(view.getByRole("cell", { name: "LDL" })).toBeDefined();
	});
});
