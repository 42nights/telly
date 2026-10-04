import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { WhoopField, whoopCatalog } from "./whoop-catalog";

const data = join(import.meta.dir, "../../../noop/whoop/data");

test("the catalog holds every exported column and never presents an unavailable or unsupported field as measured", () => {
	const files = readdirSync(data).filter((file) => file.endsWith(".json"));
	expect(files).toHaveLength(17);
	for (const file of files) {
		const rows: object[] = JSON.parse(readFileSync(join(data, file), "utf8"));
		const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
		const table = file.replace(/\.json$/, "");
		expect({
			table,
			columns: whoopCatalog
				.filter((field) => field.table === table)
				.map((field) => field.column)
				.toSorted(),
		}).toEqual({ table, columns: columns.toSorted() });
	}

	const decode = Schema.decodeUnknownSync(WhoopField);
	const spo2 = whoopCatalog.find((field) => field.column === "spo2Pct");
	const ecg = whoopCatalog.find((field) => field.table === "live.ecg");
	expect(() => decode({ ...spo2, metric: "recovery" })).toThrow();
	expect(() => decode({ ...ecg, status: "measured" })).toThrow();
	expect(() => decode({ ...ecg, metric: "heart_rate" })).toThrow();
});
