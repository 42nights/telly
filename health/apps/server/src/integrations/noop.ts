import type { NoopConnection } from "@health/contracts";
import { Effect } from "effect";

/**
 * Stub of the NOOP-to-server connection. NOOP itself is a separate, friend-owned app; this boundary
 * performs no network, BLE, ingestion, database write, or scheduling. It never reports readings, an
 * empty history, zero values, or WHOOP-derived nudges. Replace this effect when the real
 * connection is handed off; keep the result shape in `@health/contracts`.
 */
export const noopConnection: Effect.Effect<NoopConnection> = Effect.succeed({
	source: "noop",
	status: "not_connected",
});
