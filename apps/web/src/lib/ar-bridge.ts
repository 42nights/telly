// The AR object pin bridge to the iOS shell (contract: telly-ar-pin). A request goes out through
// `ReactNativeWebView.postMessage`; the shell answers with a "telly-ar" CustomEvent that echoes the
// request's `requestId`. Outside the shell (web, Android) there is no bridge, so AR is unsupported.
// Since #351 the AR screen follows the member's other pinned objects, and `watchAr` reads its
// messages (a camera frame to check, objects that moved) one at a time until it closes.
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
const MapPin = Schema.Struct({
	objectId: Schema.String,
	anchorId: Schema.String,
});
export type MapPin = typeof MapPin.Type;
const PinSaved = Schema.Struct({
	type: Schema.Literal("ar.pinSaved"),
	requestId: Schema.String,
	anchorId: Schema.String,
	worldMap: Schema.String,
	mapBytes: Schema.Number,
	/** Every pin in the saved room map. Shells from before #351 send none. */
	anchors: Schema.optionalKey(Schema.Array(MapPin)),
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
/** The open AR screen asks for a vision check of its camera frame (upright base64 JPEG). */
const ArCheck = Schema.Struct({
	type: Schema.Literal("ar.check"),
	requestId: Schema.String,
	checkId: Schema.String,
	objectIds: Schema.Array(Schema.String),
	image: Schema.String,
	width: Schema.Int,
	height: Schema.Int,
	capturedAt: Schema.String,
});
/** The check confirmed objects more than 0.5 m from their anchors; the screen moved the anchors. */
const ArMoved = Schema.Struct({
	type: Schema.Literal("ar.moved"),
	requestId: Schema.String,
	checkId: Schema.String,
	objectIds: Schema.Array(Schema.String),
	/** The room map with the moved anchors, missing when it could not be saved. */
	worldMap: Schema.optionalKey(Schema.String),
	anchors: Schema.optionalKey(Schema.Array(MapPin)),
});
const ArClosed = Schema.Struct({
	type: Schema.Literal("ar.closed"),
	requestId: Schema.String,
});
const ArReply = Schema.Union([
	Capabilities,
	PinSaved,
	PinFound,
	ArErrorReply,
	ArCheck,
	ArMoved,
	ArClosed,
]);
type ArReply = typeof ArReply.Type;
const decodeReply = Schema.decodeUnknownOption(ArReply);

/** A message of the open AR screen. */
export type ArEvent = typeof ArCheck.Type | typeof ArMoved.Type;

/** Another pinned object of the member, followed while the AR screen runs. */
export type PinnedObject = {
	readonly objectId: string;
	readonly label: string;
};

/** The answer to an `ar.check`: the center of each confirmed object's box, in picture pixels. */
export type CheckAnswer = {
	readonly checkId: string;
	readonly found: readonly {
		readonly objectId: string;
		readonly x: number;
		readonly y: number;
	}[];
};

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
			readonly session: string;
			readonly others: readonly PinnedObject[];
			readonly worldMap?: string;
	  }
	| {
			readonly type: "ar.findPin";
			readonly objectId: string;
			readonly label: string;
			readonly anchorId: string;
			readonly worldMap: string;
			readonly session: string;
			readonly others: readonly PinnedObject[];
	  }
	| {
			readonly type: "ar.watch";
			readonly session: string;
			readonly answer?: CheckAnswer;
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

/**
 * Opens the AR screen to pin `objectId`; resolves with the anchor and the room's world map.
 * `worldMap` is the member's room map, so the new pin joins the pins already in it.
 */
export const savePin = async (pin: {
	readonly familyId: string;
	readonly objectId: string;
	readonly label: string;
	readonly session: string;
	readonly others: readonly PinnedObject[];
	readonly worldMap?: string;
}): Promise<
	| {
			readonly kind: "saved";
			readonly anchorId: string;
			readonly worldMap: string;
			readonly mapBytes: number;
			readonly anchors: readonly MapPin[];
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
		anchors: reply.anchors ?? [],
	};
};

/** Opens the AR screen with a saved world map; resolves once the marker shows at the anchor. */
export const findPin = async (pin: {
	readonly objectId: string;
	readonly label: string;
	readonly anchorId: string;
	readonly worldMap: string;
	readonly session: string;
	readonly others: readonly PinnedObject[];
}): Promise<{ readonly kind: "found" } | ArFailure> => {
	const reply = await send({ type: "ar.findPin", ...pin }, SESSION_TIMEOUT_MS);
	return reply?.type === "ar.pinFound" ? { kind: "found" } : failure(reply);
};

/**
 * The next message of the AR screen opened with `session`, sending `answer` to its last check.
 * `null` once the screen closed, or when the shell does not answer (one built before #351).
 */
export const watchAr = async (
	session: string,
	answer?: CheckAnswer,
): Promise<ArEvent | null> => {
	const reply = await send(
		{ type: "ar.watch", session, ...(answer === undefined ? {} : { answer }) },
		SESSION_TIMEOUT_MS,
	);
	return reply?.type === "ar.check" || reply?.type === "ar.moved"
		? reply
		: null;
};
