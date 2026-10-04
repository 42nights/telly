import {
	FinchnodeLab,
	type FinchnodeSubjectLabs,
} from "@health/contracts/reports";
import { Exit, Schema } from "effect";
import { ApiFailure } from "../http";

// FinchNode reads a consenting patient's health records (https://finchnode.com/docs). It never
// writes back to a health system. API reference: https://finchnode.com/docs/api (contract
// 2026-09-22); keyless demo: https://finchnode.com/docs/get-started/demo-api.

/** How the server reaches FinchNode. `synthetic`: only fictional patients (demo or `ck_test_` key). */
export type Finchnode = {
	readonly kind: "demo" | "api";
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly synthetic: boolean;
};

/** `FINCHNODE_MODE` and `FINCHNODE_API_KEY`. `undefined` when FinchNode is off. */
export const finchnodeFromEnv = (
	mode: "off" | "demo" | "api",
	apiKey: string | undefined,
): Finchnode | undefined => {
	if (mode === "off") return undefined;
	if (mode === "demo")
		return {
			kind: "demo",
			baseUrl: "https://api.finchnode.com/demo/v1",
			apiKey: undefined,
			synthetic: true,
		};
	if (apiKey === undefined || apiKey === "")
		throw new Error("FINCHNODE_MODE=api needs FINCHNODE_API_KEY");
	return {
		kind: "api",
		baseUrl: "https://api.finchnode.com/api/v1",
		apiKey,
		synthetic: apiKey.startsWith("ck_test_"),
	};
};

const statusError = (status: number) =>
	new ApiFailure(
		// Rate limits and server errors pass; anything else means this request is wrong.
		status === 429 || status >= 500 ? "unavailable" : "upstream_error",
		`Finchnode answered HTTP ${status}`,
	);

const decode = <T>(schema: Schema.Decoder<T>, json: unknown): T => {
	const exit = Schema.decodeUnknownExit(schema)(json);
	if (Exit.isFailure(exit))
		throw new ApiFailure(
			"upstream_error",
			"Finchnode sent an unexpected response",
		);
	return exit.value;
};

const call = async (
	finchnode: Finchnode,
	path: string,
	signal: AbortSignal,
	body?: unknown,
) => {
	const headers: Record<string, string> = { accept: "application/json" };
	if (finchnode.apiKey !== undefined)
		headers.authorization = `Bearer ${finchnode.apiKey}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	try {
		const response = await fetch(`${finchnode.baseUrl}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		});
		return {
			status: response.status,
			json: (await response.json().catch(() => undefined)) as unknown,
		};
	} catch {
		throw new ApiFailure("unavailable", "Finchnode did not respond");
	}
};

const DemoSession = Schema.Struct({
	id: Schema.String,
	status: Schema.Literal("complete"),
	patient_id: Schema.String,
	connect_url: Schema.String,
});
const CreatedSession = Schema.Struct({ id: Schema.String, url: Schema.String });

/**
 * Starts FinchNode Connect for labs, tagged with the family id. The demo finishes at once and
 * returns its fictional subject; a real session returns `subject: null` until the patient finishes.
 */
export const createSession = async (
	finchnode: Finchnode,
	familyId: string,
	signal: AbortSignal,
) => {
	if (finchnode.kind === "demo") {
		const { status, json } = await call(
			finchnode,
			"/connect/sessions",
			signal,
			{
				external_user_id: `family-${familyId}`,
				categories: ["labs"],
			},
		);
		if (status !== 201) throw statusError(status);
		const session = decode(DemoSession, json);
		return {
			sessionId: session.id,
			url: session.connect_url,
			subject: session.patient_id,
		};
	}
	const { status, json } = await call(finchnode, "/connect/sessions", signal, {
		externalId: familyId,
		categories: ["labs"],
	});
	if (status !== 201) throw statusError(status);
	const session = decode(CreatedSession, json);
	return { sessionId: session.id, url: session.url, subject: null };
};

const Session = Schema.Struct({
	status: Schema.String,
	subject: Schema.NullOr(Schema.String),
	externalId: Schema.NullOr(Schema.String),
});

/**
 * The subject of a finished Connect session that this family started, or `null` while the patient
 * has not finished. `undefined`: no such session for this family.
 */
export const sessionSubject = async (
	finchnode: Finchnode,
	sessionId: string,
	familyId: string,
	signal: AbortSignal,
) => {
	// Real session ids are `cs_` and 20 hex digits; nothing else reaches the URL path.
	if (finchnode.kind === "demo" || !/^cs_[a-f0-9]{20}$/.test(sessionId))
		return undefined;
	const { status, json } = await call(
		finchnode,
		`/connect/sessions/${sessionId}`,
		signal,
	);
	if (status === 404) return undefined;
	if (status !== 200) throw statusError(status);
	const session = decode(Session, json);
	if (session.externalId !== familyId) return undefined;
	return session.status === "completed" ? session.subject : null;
};

const ErrorCode = Schema.Struct({
	error: Schema.Struct({ code: Schema.String }),
});
const LabRecord = Schema.Struct({
	sources: Schema.Array(
		Schema.Struct({
			system: Schema.String,
			organization: Schema.NullOr(Schema.String),
			lastSyncedAt: Schema.NullOr(Schema.String),
		}),
	),
	data: Schema.Struct({ labs: Schema.optionalKey(Schema.Array(FinchnodeLab)) }),
	meta: Schema.Struct({
		syncStatus: Schema.String,
		dataAsOf: Schema.NullOr(Schema.String),
		warnings: Schema.Array(Schema.Struct({ code: Schema.String })),
	}),
});

/** One subject's laboratory results. A revoked or narrower consent is a result, not an error. */
export const subjectLabs = async (
	finchnode: Finchnode,
	subject: string,
	signal: AbortSignal,
): Promise<FinchnodeSubjectLabs> => {
	const { status, json } = await call(
		finchnode,
		`/users/${encodeURIComponent(subject)}/records?categories=labs`,
		signal,
	);
	const without = (access: "inactive" | "not_granted") => ({
		subject,
		synthetic: finchnode.synthetic,
		access,
		syncStatus: null,
		dataAsOf: null,
		warnings: [],
		sources: [],
		labs: [],
	});
	if (status === 410) return without("inactive");
	if (
		status === 403 &&
		decode(ErrorCode, json).error.code === "consent_scope_exceeded"
	)
		return without("not_granted");
	if (status !== 200) throw statusError(status);
	const record = decode(LabRecord, json);
	return {
		subject,
		synthetic: finchnode.synthetic,
		access: "granted",
		syncStatus: record.meta.syncStatus,
		dataAsOf: record.meta.dataAsOf,
		warnings: record.meta.warnings.map((warning) => warning.code),
		sources: record.sources,
		labs: record.data.labs ?? [],
	};
};
