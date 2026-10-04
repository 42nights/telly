import { Schema, Struct } from "effect";
import { Alert, AlertAcknowledgement, HealthSample } from "./index";
import { MedicineSighting } from "./medicine-memory";

// Agent tools: `POST /api/families/:familyId/tools`. The caller's identity must be a member of
// the family; every result holds only that family's records. A tool not listed here is rejected.

const Limit = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 100 }),
).annotate({ description: "Most records to return (default 20)." });

const HealthSamplesTool = Schema.Struct({
	tool: Schema.Literal("health_samples"),
	input: Schema.Struct({
		metric: Schema.optionalKey(
			Schema.NonEmptyString.annotate({
				description: "Only samples of this metric, such as heart_rate.",
			}),
		),
		limit: Schema.optionalKey(Limit),
	}),
}).annotate({
	identifier: "HealthSamplesTool",
	description: "The family's newest health samples, newest source time first.",
});

const AlertsTool = Schema.Struct({
	tool: Schema.Literal("alerts"),
	input: Schema.Struct({ limit: Schema.optionalKey(Limit) }),
}).annotate({
	identifier: "AlertsTool",
	description:
		"The family's newest alerts and the acknowledgements of those alerts.",
});

const SavedThingsTool = Schema.Struct({
	tool: Schema.Literal("saved_things"),
	input: Schema.Struct({ limit: Schema.optionalKey(Limit) }),
}).annotate({
	identifier: "SavedThingsTool",
	description:
		"Where the asking person saved each of their things, such as pills or keys, newest first. A place is where it was saved, not proof that it is still there. A place can name a landmark, such as a dish rack or a cabinet.",
});

export const ToolRequest = Schema.Union([
	HealthSamplesTool,
	AlertsTool,
	SavedThingsTool,
]);
export type ToolRequest = typeof ToolRequest.Type;

export const ToolResponse = Schema.Union([
	Schema.Struct({
		tool: Schema.Literal("health_samples"),
		samples: Schema.Array(HealthSample),
	}),
	Schema.Struct({
		tool: Schema.Literal("alerts"),
		alerts: Schema.Array(Alert),
		acknowledgements: Schema.Array(AlertAcknowledgement),
	}),
	Schema.Struct({
		tool: Schema.Literal("saved_things"),
		things: Schema.Array(
			MedicineSighting.mapFields(
				Struct.pick([
					"id",
					"container",
					"category",
					"place",
					"seenAt",
					"notFoundAt",
				]),
			),
		),
	}),
]);
export type ToolResponse = typeof ToolResponse.Type;
