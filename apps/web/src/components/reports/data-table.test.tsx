import "../test/env";

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { installDom, serve } from "../test/dom";

import { DataTable } from "./data-table";

installDom();

describe("DataTable", () => {
	test("shows each header as a column and the rows as the body", () => {
		serve({});
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
