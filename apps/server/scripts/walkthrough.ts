// Hackathon walkthrough (issue #51, docs/walkthrough.md): one synthetic wearer history through
// conversation, medication, meal, family handoff, and report, over the real HTTP routes of the built
// server and a private in-memory SpacetimeDB. Provider keys are never set, so every Gemini and
// ElevenLabs step must answer `unavailable`; that is the outage this walkthrough records.
// Nothing leaves 127.0.0.1: no call, message, purchase, or hospital delivery is real.
// Usage: bun run --filter server build && bun run walkthrough
//   WALKTHROUGH_PORT: first of three ports (default 45510: database, issuer, server).
//   KEEP=1: keep the stack running for the web app (CORS origin http://127.0.0.1:<port + 3>).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sign } from "hono/jwt";

const dbPort = Number(process.env.WALKTHROUGH_PORT ?? 45510);
const issuerPort = dbPort + 1;
const serverPort = dbPort + 2;
const webPort = dbPort + 3;
const dbUrl = `http://127.0.0.1:${dbPort}`;
const issuer = `http://127.0.0.1:${issuerPort}`;
const server = `http://127.0.0.1:${serverPort}`;
const audience = "telly-walkthrough";
const database = "telly-walkthrough";
const work = mkdtempSync(join(tmpdir(), "telly-walkthrough-"));
const cli = ["--config-path", join(work, "cli.toml")];
const children: ChildProcess[] = [];

const stop = () => {
	for (const child of children) child.kill("SIGTERM");
	issuerServer.stop(true);
	rmSync(work, { recursive: true, force: true });
};

const waitFor = async (what: string, ready: () => Promise<boolean>) => {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await ready().catch(() => false)) return;
		await sleep(200);
	}
	throw new Error(`${what} did not start`);
};

// A test-only OIDC issuer with a key made for this run. `/token?user=` signs an ID token, which
// the web app accepts in sessionStorage["telly.session.token"] for the KEEP=1 screenshots.
const pair = await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
);
const jwk = async (key: CryptoKey) => ({
	...(await crypto.subtle.exportKey("jwk", key)),
	kid: "walkthrough",
	alg: "RS256",
});
const publicJwk = await jwk(pair.publicKey);
const privateJwk = await jwk(pair.privateKey);
const idToken = (user: string) => {
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{
			iss: issuer,
			sub: `walkthrough-${user}`,
			aud: audience,
			name: user,
			iat: now,
			exp: now + 12 * 3600,
		},
		privateJwk,
		"RS256",
	);
};
const issuerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: issuerPort,
	fetch: async (request) => {
		const url = new URL(request.url);
		const cors = { "Access-Control-Allow-Origin": "*" };
		if (url.pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
		if (url.pathname === "/jwks") return Response.json({ keys: [publicJwk] });
		if (url.pathname === "/token")
			return new Response(await idToken(url.searchParams.get("user") ?? ""), {
				headers: cors,
			});
		return new Response(null, { status: 404 });
	},
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		stop();
		process.exit(130);
	});

try {
	// Never publish to, or stop, a database this run did not start.
	await fetch(`${dbUrl}/v1/ping`).then(
		() => {
			throw new Error(`${dbUrl} is in use; set WALKTHROUGH_PORT`);
		},
		() => undefined,
	);
	children.push(
		spawn(
			"spacetime",
			[
				...cli,
				"start",
				"--in-memory",
				"--non-interactive",
				"--data-dir",
				join(work, "stdb"),
				"--listen-addr",
				`127.0.0.1:${dbPort}`,
			],
			{ stdio: "ignore" },
		),
	);
	await waitFor(
		"SpacetimeDB",
		async () => (await fetch(`${dbUrl}/v1/ping`)).ok,
	);
	const { token: operator } = (await (
		await fetch(`${dbUrl}/v1/identity`, { method: "POST" })
	).json()) as { token: string };
	execFileSync("spacetime", [...cli, "login", "--token", operator], {
		stdio: "ignore",
	});
	execFileSync(
		"spacetime",
		[
			...cli,
			"publish",
			"--server",
			dbUrl,
			"--module-path",
			"spacetimedb",
			"--yes",
			database,
		],
		{
			cwd: new URL("../../../", import.meta.url).pathname,
			stdio: "ignore",
		},
	);

	const env = { ...process.env };
	// No provider keys: Gemini and ElevenLabs must answer `unavailable`, never a fake success.
	for (const key of Object.keys(env))
		if (/GEMINI|ELEVENLABS|FINCHNODE|QWEN|TELLY_R2|TELLY_FETCH/.test(key))
			delete env[key];
	children.push(
		spawn("node", ["dist/index.mjs"], {
			cwd: new URL("../", import.meta.url),
			env: {
				...env,
				NODE_ENV: "development",
				HOST: "127.0.0.1",
				PORT: String(serverPort),
				CORS_ORIGIN: `http://127.0.0.1:${webPort}`,
				OIDC_ISSUER: issuer,
				OIDC_AUDIENCE: audience,
				SPACETIMEDB_URI: `ws://127.0.0.1:${dbPort}`,
				SPACETIMEDB_DATABASE: database,
				ALERT_OPERATOR_TOKEN: operator,
				FINCHNODE_MODE: "off",
			},
			stdio: ["ignore", "ignore", "inherit"],
		}),
	);
	await waitFor("server", async () => (await fetch(`${server}/health`)).ok);

	const tokens = {
		rosa: await idToken("rosa"),
		priya: await idToken("priya"),
		sam: await idToken("sam"),
	};
	type Who = keyof typeof tokens;
	const call = async <T = Record<string, unknown>>(
		who: Who,
		method: string,
		path: string,
		body?: unknown,
		expect = [200, 201, 204],
	): Promise<{ status: number; json: T }> => {
		const response = await fetch(`${server}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${tokens[who]}`,
				...(body === undefined || body instanceof Blob
					? {}
					: { "Content-Type": "application/json" }),
			},
			...(body === undefined
				? {}
				: { body: body instanceof Blob ? body : JSON.stringify(body) }),
		});
		const text = await response.text();
		const json = (text === "" ? {} : JSON.parse(text)) as T;
		console.log(
			`${who} ${method} ${path} -> ${response.status}${response.ok ? "" : ` ${text}`}`,
		);
		if (!expect.includes(response.status))
			throw new Error(`${method} ${path}: ${response.status} ${text}`);
		return { status: response.status, json };
	};
	const check = (ok: boolean, what: string) => {
		if (!ok) throw new Error(`walkthrough: ${what}`);
		console.log(`  ok: ${what}`);
	};
	const unavailable = [503];

	// 0. One family: Rosa wears nothing (glasses disconnected); Priya and Sam are family.
	const { json: sources } = await call<{
		sources: { source: string; status: string }[];
	}>("rosa", "GET", "/api/sources");
	check(
		sources.sources.find((s) => s.source === "noop")?.status ===
			"not_connected",
		"the NOOP adapter is not_connected",
	);
	const { json: family } = await call<{ id: string }>(
		"rosa",
		"POST",
		"/api/families",
		{ name: "Rosa (synthetic walkthrough)" },
	);
	const f = `/api/families/${family.id}`;
	const ids = {} as Record<Who, string>;
	for (const who of ["rosa", "priya", "sam"] as const)
		ids[who] = (
			await call<{ identity: string }>(who, "GET", "/api/me")
		).json.identity;
	for (const who of ["priya", "sam"] as const)
		await call("rosa", "POST", `${f}/members`, { identity: ids[who] });
	for (const who of ["rosa", "priya"] as const)
		for (const scope of ["health_records", "media"])
			await call("rosa", "POST", `${f}/care-access`, {
				identity: ids[who],
				scope,
				granted: true,
			});

	const sampleIds: string[] = [];
	for (const [metric, value, unit, minutes] of [
		["heart_rate", 76, "bpm", 20],
		["spo2", 96, "%", 18],
		["steps", 1840, "steps", 15],
	] as const)
		sampleIds.push(
			(
				await call<{ id: string }>("rosa", "POST", `${f}/samples`, {
					metric,
					value,
					unit,
					sourceTime: new Date(Date.now() - minutes * 60_000).toISOString(),
					source: "walkthrough-synthetic",
					synthetic: true,
					quality: "unvalidated",
				})
			).json.id,
		);

	// 1. Conversation in Spanish and English. Voice and Gemini answers are unavailable here.
	await call(
		"rosa",
		"POST",
		`${f}/voice/transcriptions?languageCode=es`,
		new Blob([new Uint8Array(64)], { type: "audio/webm" }),
		unavailable,
	);
	await call(
		"rosa",
		"POST",
		`${f}/ask`,
		{ question: "¿Dónde están mis pastillas?", asker: "wearer" },
		unavailable,
	);
	const wearerWords =
		"¿Dónde están mis pastillas? No me acuerdo si tomé la de las nueve.";
	const { json: rosaMessage } = await call<{ id: string }>(
		"rosa",
		"POST",
		`${f}/messages`,
		{ clientId: "walkthrough-rosa-1", body: wearerWords },
	);
	const { json: priyaMessage } = await call<{ id: string }>(
		"priya",
		"POST",
		`${f}/messages`,
		{
			clientId: "walkthrough-priya-1",
			body: "Mom, the bottle is on the kitchen counter. I will check the dose with you.",
		},
	);

	// 2. Scheduled medication: prompted, acknowledged, then unsure. Never marked as taken.
	const now = new Date();
	const inOneMinute = new Date(now.getTime() + 60_000);
	await call("rosa", "PUT", `${f}/reminder-settings`, {
		timeZone: "UTC",
		quietHours: null,
		repeatEveryMinutes: 5,
		maxPrompts: 3,
		snoozeMinutes: 10,
	});
	await call("rosa", "POST", `${f}/reminders`, {
		kind: "medication",
		subjectId: null,
		title: "Lisinopril 10 mg (synthetic)",
		times: [inOneMinute.toISOString().slice(11, 16)],
	});
	type Occurrence = {
		occurrence: { id: string; state: string; promptDue: boolean };
		events: { state: string }[];
	};
	let due: Occurrence | undefined;
	for (let attempt = 0; due === undefined; attempt++) {
		if (attempt === 60) throw new Error("the medication prompt never came due");
		const { json } = await call<{ occurrences: Occurrence[] }>(
			"rosa",
			"GET",
			`${f}/reminder-occurrences`,
		);
		due = json.occurrences.find((o) => o.occurrence.promptDue);
		if (due === undefined) await sleep(2000);
	}
	const occurrence = `${f}/reminder-occurrences/${due.occurrence.id}`;
	await call("rosa", "POST", `${occurrence}/deliveries`, {
		clientId: "walkthrough-delivery-1",
		source: "phone",
	});
	const { json: acknowledged } = await call<Occurrence>(
		"rosa",
		"POST",
		`${occurrence}/answers`,
		{
			clientId: "walkthrough-answer-1",
			source: "phone",
			response: "okay",
			wording: "Vale",
		},
	);
	check(
		acknowledged.occurrence.state === "acknowledged",
		"an acknowledgment records acknowledged, not taken",
	);

	// Find the container. The sighting is a synthetic fixture: no camera check ran.
	await call(
		"rosa",
		"POST",
		`${f}/vision/medicine-detections`,
		{},
		unavailable,
	);
	await call("rosa", "PUT", `${f}/medicine-memory`, {
		enabled: true,
		places: ["kitchen counter", "bedside table"],
	});
	const bottle = {
		container: "Lisinopril bottle (synthetic)",
		seenAt: new Date().toISOString(),
		source: "camera_check",
		confidence: 0.91,
		labelRead: true,
	};
	const { json: memory } = await call<{ sightings: { id: string }[] }>(
		"rosa",
		"POST",
		`${f}/medicine-memory/sightings`,
		{ ...bottle, place: "kitchen counter" },
	);
	const staleSighting = memory.sightings[0]?.id;
	// Failure: the container moved. The old place is marked outdated, then found again.
	const { json: moved } = await call<{
		sightings: { notFoundAt: string | null }[];
	}>(
		"rosa",
		"POST",
		`${f}/medicine-memory/sightings/${staleSighting}/not-found`,
	);
	check(
		moved.sightings[0]?.notFoundAt != null,
		"the old place shows as outdated, not as the bottle's place",
	);
	const { json: found } = await call<{
		sightings: { id: string; place: string; notFoundAt: string | null }[];
	}>("rosa", "POST", `${f}/medicine-memory/sightings`, {
		...bottle,
		place: "bedside table",
		seenAt: new Date().toISOString(),
	});
	const { json: unsure } = await call<Occurrence>(
		"rosa",
		"POST",
		`${occurrence}/answers`,
		{
			clientId: "walkthrough-answer-2",
			source: "phone",
			response: "unsure",
			wording: "No me acuerdo si la tomé",
		},
	);
	check(
		unsure.occurrence.state === "unresolved" &&
			!unsure.events.some((e) =>
				["self_reported_complete", "caregiver_confirmed"].includes(e.state),
			),
		"finding the bottle and saying unsure leave the dose unresolved",
	);

	// 3. Meal photo, then a separate intake report. The estimate is unavailable here.
	const mealId = "walkthrough-lunch";
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	await call(
		"rosa",
		"POST",
		`${f}/meals/${mealId}/estimates`,
		{
			source: "photo",
			capturedAt: new Date().toISOString(),
			image: { type: "image/png", data: png },
		},
		unavailable,
	);
	const meal = async () =>
		(
			await call<{ meals: { mealId: string; intake: string }[] }>(
				"rosa",
				"GET",
				`${f}/meals`,
			)
		).json.meals.find((m) => m.mealId === mealId);
	check(
		(await meal())?.intake === "not_reported",
		"a meal photo alone reports no intake",
	);
	await call("rosa", "POST", `${f}/meals/${mealId}/intake`, {
		type: "intake_report",
		kind: "meal",
		amount: "some",
		reportedBy: "wearer",
		words: "Comí la mitad",
		via: "text",
	});
	check(
		(await meal())?.intake === "reported",
		"only the intake report sets intake",
	);

	// 4. Family handoff: Sam does not answer, Priya accepts and confirms help. Calls are simulated.
	const ladderEntry = { timeZone: "UTC", detail: "facts", callFor: [] };
	await call("rosa", "PUT", `${f}/care/ladder`, {
		contacts: [
			{ ...ladderEntry, member: ids.sam, name: "Sam" },
			{ ...ladderEntry, member: ids.priya, name: "Priya" },
		],
		backup: null,
		answerSeconds: 10,
		followUpSeconds: 600,
	});
	type Need = {
		id: string;
		status: string;
		attempts: { name: string; status: string }[];
	};
	const { json: need } = await call<Need>("rosa", "POST", `${f}/care/needs`, {
		clientId: "walkthrough-need-1",
		kind: "help",
		summary: `Rosa is unsure whether she took Lisinopril (reminder occurrence ${due.occurrence.id})`,
		sampleIds,
		dueAt: null,
	});
	const needPath = `${f}/care/needs/${need.id}`;
	let reached: Need | undefined;
	for (let attempt = 0; reached === undefined; attempt++) {
		if (attempt === 30) throw new Error("the ladder never reached Priya");
		const { json } = await call<Need>("priya", "GET", needPath);
		if (json.attempts.some((a) => a.name === "Priya")) reached = json;
		else await sleep(1000);
	}
	check(
		reached.attempts.find((a) => a.name === "Sam")?.status === "no_answer" &&
			reached.status === "open",
		"Sam's silence leaves the need open and moves it to Priya",
	);
	await call("priya", "POST", `${needPath}/responses`, { response: "accept" });
	const { json: accepted } = await call<Need>("priya", "GET", needPath);
	check(accepted.status === "accepted", "acceptance alone does not resolve it");
	await call("priya", "POST", `${needPath}/responses`, {
		response: "help_confirmed",
	});
	const { json: resolved } = await call<Need>("priya", "GET", needPath);
	check(resolved.status === "resolved", "confirmed help resolves the need");

	// 5. Report from the same synthetic samples, then a delivery that stays unavailable.
	type Report = {
		id: string;
		markers: {
			metric: string;
			sample: { id: string; synthetic: boolean } | null;
		}[];
	};
	const { json: report } = await call<Report>("priya", "POST", `${f}/reports`);
	const measured = report.markers.flatMap((m) => (m.sample ? [m.sample] : []));
	check(
		measured.length === sampleIds.length &&
			measured.every((s) => s.synthetic && sampleIds.includes(s.id)),
		"every report marker is one of the walkthrough's synthetic samples",
	);
	await call("priya", "POST", `${f}/reports/${report.id}/fields`, {
		patientName: "Rosa Example (synthetic)",
		dateOfBirth: null,
		patientId: null,
		physician: null,
		hospital: null,
		notes: "Synthetic walkthrough data. Not a real patient.",
		observations: [
			`Medication occurrence ${due.occurrence.id}: acknowledged, then unsure ("No me acuerdo si la tomé"); unresolved.`,
			`Meal ${mealId}: photo taken, estimate unavailable; Rosa reported "some" ("Comí la mitad").`,
			`Care need ${need.id}: Sam no answer; Priya accepted and confirmed help.`,
			`Family chat messages ${rosaMessage.id} and ${priyaMessage.id}.`,
		].join("\n"),
		questions:
			"Should a missed or uncertain Lisinopril dose change the next one?",
		corrections: [],
	});
	await call("priya", "POST", `${f}/reports/${report.id}/review`);
	await call(
		"priya",
		"POST",
		`${f}/reports/${report.id}/submit`,
		undefined,
		unavailable,
	);

	console.log(
		JSON.stringify(
			{
				family: family.id,
				samples: sampleIds,
				messages: [rosaMessage.id, priyaMessage.id],
				medicationOccurrence: {
					id: due.occurrence.id,
					state: unsure.occurrence.state,
				},
				sightings: found.sightings.map(({ id, place, notFoundAt }) => ({
					id,
					place,
					outdated: notFoundAt !== null,
				})),
				meal: { id: mealId, intake: (await meal())?.intake },
				careNeed: {
					id: need.id,
					status: resolved.status,
					attempts: resolved.attempts,
				},
				report: report.id,
			},
			null,
			2,
		),
	);
	console.log("walkthrough: ok");
	if (process.env.KEEP) {
		console.log(
			`KEEP=1: server ${server}; web origin http://127.0.0.1:${webPort}; token ${issuer}/token?user=rosa|priya|sam. Ctrl-C stops.`,
		);
		await Promise.withResolvers<void>().promise;
	}
} finally {
	if (!process.env.KEEP) stop();
}
