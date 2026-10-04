// Writes the Fetch.ai worker's contract (agents/fetch/contract.json) from the shared schemas, so
// the Python worker validates against the same definitions as the server. CI fails on drift.
import { Schema } from "effect";
import { ApiError } from "../src/index";
import { ToolRequest, ToolResponse } from "../src/tools";

const document = (schema: Schema.Constraint) => {
	const { schema: root, definitions } = Schema.toJsonSchemaDocument(schema, {
		onExcessProperty: "error",
	});
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		...root,
		$defs: definitions,
	};
};

const contract = {
	ToolRequest: document(ToolRequest),
	ToolResponse: document(ToolResponse),
	ApiError: document(ApiError),
};

await Bun.write(
	new URL("../../../agents/fetch/contract.json", import.meta.url),
	`${JSON.stringify(contract, null, "\t")}\n`,
);
