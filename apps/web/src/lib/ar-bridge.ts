// The AR object pin bridge to the iOS shell (contract: telly-ar-pin). A request goes out through
// `ReactNativeWebView.postMessage`; the shell answers with a "telly-ar" CustomEvent that echoes the
// request's `requestId`. Outside the shell (web, Android) there is no bridge, so AR is unsupported.
import { Schema } from "effect";

const Capabilities = Schema.Struct({
	type: Schema.Literal("ar.capabilities"),
	requestId: Schema.String,
	supported: Schema.Boolean,
	reason: Schema.optional(
		Schema.Literals(["no-arkit", "no-camera-permission", "not-ios"]),
	),
});
// The replies also echo the object id: `objectId` from shells built since #301, `containerId` from
// older ones. The `requestId` already matches a reply to its request, so neither is read.
const PinSaved = Schema.Struct({
	type: Schema.Literal("ar.pinSaved"),
	requestId: Schema.String,
	anchorId: Schema.String,
	worldMap: Schema.String,
	mapBytes: Schema.Number,
});
const PinFound = Schema.Struct({
	type: Schema.Literal("ar.pinFound"),
	requestId: Schema.String,
});
const ArErrorCode = Schema.Literals([
	"cancelled",
	"mapping-not-ready",
	"camera-denied",
	"relocalization-failed",
	"failed",
]);
const ArErrorReply = Schema.Struct({
	type: Schema.Literal("ar.error"),
	requestId: Schema.String,
	code: ArErrorCode,
	message: Schema.String,
});
const ArReply = Schema.Union([Capabilities, PinSaved, PinFound, ArErrorReply]);
type ArReply = typeof ArReply.Type;
const decodeReply = Schema.decodeUnknownOption(ArReply);

export type ArCapabilities = {
	readonly supported: boolean;
	readonly reason?: (typeof Capabilities.Type)["reason"];
};

/** A failed AR request: the shell's error code, or `timeout` when it did not answer in time. */
export type ArFailure = {
	readonly kind: "error";
	readonly code: typeof ArErrorCode.Type | "timeout";
	readonly message: string;
};

/** Capabilities are answered at once; save and find wait while the person scans the room. */
export const CAPABILITIES_TIMEOUT_MS = 3_000;
const SESSION_TIMEOUT_MS = 10 * 60_000;

type Request =
	| { readonly type: "ar.capabilities" }
	| {
			readonly type: "ar.savePin";
			readonly familyId: string;
			readonly objectId: string;
			readonly label: string;
	  }
	| {
			readonly type: "ar.findPin";
			readonly objectId: string;
			readonly label: string;
			readonly anchorId: string;
			readonly worldMap: string;
	  };

/** Sends `request` and resolves with the reply that echoes its id, or `null` (no bridge, timeout). */
const send = (request: Request, timeoutMs: number) =>
	new Promise<ArReply | null>((resolve) => {
		const bridge = globalThis.ReactNativeWebView;
		if (bridge === undefined) return resolve(null);
		const requestId = crypto.randomUUID();
		const onReply = (event: Event) => {
			const reply = decodeReply((event as CustomEvent<unknown>).detail);
			if (reply._tag === "Some" && reply.value.requestId === requestId)
				finish(reply.value);
		};
		const finish = (reply: ArReply | null) => {
			clearTimeout(timer);
			globalThis.removeEventListener("telly-ar", onReply);
			resolve(reply);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		globalThis.addEventListener("telly-ar", onReply);
		// Shells built before #301 read the object id as `containerId`.
		const old = "objectId" in request ? { containerId: request.objectId } : {};
		bridge.postMessage(JSON.stringify({ ...request, ...old, requestId }));
	});

const timedOut: ArFailure = {
	kind: "error",
	code: "timeout",
	message: "The AR screen did not answer.",
};

/** A reply that is neither the expected one nor an `ar.error` is a shell bug: report it as failed. */
const failure = (reply: ArReply | null): ArFailure =>
	reply === null
		? timedOut
		: reply.type === "ar.error"
			? { kind: "error", code: reply.code, message: reply.message }
			: {
					kind: "error",
					code: "failed",
					message: `Unexpected AR reply ${reply.type}.`,
				};

/** Whether this device can pin in AR. Without the shell, or without an answer, it cannot. */
export const arCapabilities = async (): Promise<ArCapabilities> => {
	if (globalThis.ReactNativeWebView === undefined)
		return { supported: false, reason: "not-ios" };
	const reply = await send(
		{ type: "ar.capabilities" },
		CAPABILITIES_TIMEOUT_MS,
	);
	if (reply?.type !== "ar.capabilities") return { supported: false };
	return reply.reason === undefined
		? { supported: reply.supported }
		: { supported: reply.supported, reason: reply.reason };
};

/** Opens the AR screen to pin `objectId`; resolves with the anchor and the room's world map. */
export const savePin = async (pin: {
	readonly familyId: string;
	readonly objectId: string;
	readonly label: string;
}): Promise<
	| {
			readonly kind: "saved";
			readonly anchorId: string;
			readonly worldMap: string;
			readonly mapBytes: number;
	  }
	| ArFailure
> => {
	const reply = await send({ type: "ar.savePin", ...pin }, SESSION_TIMEOUT_MS);
	if (reply?.type !== "ar.pinSaved") return failure(reply);
	return {
		kind: "saved",
		anchorId: reply.anchorId,
		worldMap: reply.worldMap,
		mapBytes: reply.mapBytes,
	};
};

/** Opens the AR screen with a saved world map; resolves once the marker shows at the anchor. */
export const findPin = async (pin: {
	readonly objectId: string;
	readonly label: string;
	readonly anchorId: string;
	readonly worldMap: string;
}): Promise<{ readonly kind: "found" } | ArFailure> => {
	const reply = await send({ type: "ar.findPin", ...pin }, SESSION_TIMEOUT_MS);
	return reply?.type === "ar.pinFound" ? { kind: "found" } : failure(reply);
};
