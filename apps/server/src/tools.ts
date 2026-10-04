import type { ToolRequest, ToolResponse } from "@health/contracts/tools";
import { type FamilyDb, readFamilyRecords } from "./db";

const defaultLimit = 20;

/** Newest first by an ISO 8601 UTC time, which sorts as text. */
const newest =
	<T>(time: (item: T) => string) =>
	(a: T, b: T) =>
		time(b).localeCompare(time(a));

/**
 * Runs one agent tool for one family. `db` acts as the caller's identity, so its views hold only
 * that identity's families; this keeps the result to `familyId` alone.
 */
export const runTool = (
	db: FamilyDb,
	familyId: string,
	request: ToolRequest,
): ToolResponse => {
	const records = readFamilyRecords(db);
	const limit = request.input.limit ?? defaultLimit;
	switch (request.tool) {
		case "health_samples": {
			const { metric } = request.input;
			return {
				tool: "health_samples",
				samples: records.samples
					.filter(
						(sample) =>
							sample.familyId === familyId &&
							(metric === undefined || sample.metric === metric),
					)
					.sort(newest((sample) => sample.sourceTime))
					.slice(0, limit),
			};
		}
		case "alerts": {
			const alerts = records.alerts
				.filter((alert) => alert.familyId === familyId)
				.sort(newest((alert) => alert.createdAt))
				.slice(0, limit);
			const ids = new Set(alerts.map((alert) => alert.id));
			return {
				tool: "alerts",
				alerts,
				acknowledgements: records.acknowledgements.filter((ack) =>
					ids.has(ack.alertId),
				),
			};
		}
	}
};
