// Backup and restore drill for the local SpacetimeDB data directory. It uses only fresh temporary
// directories, its own ports, and its own identity-signing keys. It writes synthetic records, crashes
// and restarts the database, takes a cold backup, restores it into a new directory, and compares the
// restored rows with the originals. It never touches a shared or production database.
// Usage: bun run db:drill. DRILL_PORT picks the first of two ports (default 3600; the restored server
// uses DRILL_PORT + 1).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { Timestamp } from "spacetimedb";
import { readAlerts } from "../src/alerts/records";
import {
	callDb,
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../src/db";

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();
const port = Number(process.env.DRILL_PORT ?? 3600);
const database = "health-drill";
const work = mkdtempSync(join(tmpdir(), "health-drill-"));
const original = join(work, "original");
const restored = join(work, "restored");
const archive = join(work, "backup.tar.gz");
// A CLI config in the temporary directory, so the drill never reads or writes the user's config.
const cli = ["--config-path", join(work, "cli.toml")];

// The identity tokens are signed with this key pair, so a backup that leaves it out restores rows
// that no existing token can read. `spacetime start` defaults to the keys in ~/.config/spacetime;
// the drill keeps them inside the data directory so that the archive carries them.
const keys = (dataDir: string) => ({
	priv: join(dataDir, "jwt", "id_ecdsa"),
	pub: join(dataDir, "jwt", "id_ecdsa.pub"),
});

const answers = (url: string) => {
	try {
		execFileSync("spacetime", [...cli, "server", "ping", url], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
};

const start = async (dataDir: string, at: number) => {
	const url = `http://127.0.0.1:${at}`;
	// Never publish to, read from, or stop a database this drill did not start.
	if (answers(url))
		throw new Error(`${url} is already in use; set DRILL_PORT to a free port`);
	const server = spawn(
		"spacetime",
		[
			...cli,
			"start",
			"--non-interactive",
			"--data-dir",
			dataDir,
			"--jwt-priv-key-path",
			keys(dataDir).priv,
			"--jwt-pub-key-path",
			keys(dataDir).pub,
			"--listen-addr",
			`127.0.0.1:${at}`,
		],
		{ stdio: "ignore" },
	);
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.exitCode !== null) break;
		if (answers(url) && server.exitCode === null) return { server, url };
		await sleep(200);
	}
	throw new Error(`SpacetimeDB did not start on ${url}`);
};

const stop = async (server: ChildProcess, signal: NodeJS.Signals) => {
	const exited = once(server, "exit");
	server.kill(signal);
	await exited;
};

// Every row the family identity sees, plus each alert with its delivery state.
const snapshot = (family: FamilyDb) => {
	const records = readFamilyRecords(family);
	return {
		records,
		alerts: readAlerts(family, records.families[0]?.id ?? ""),
	};
};

// Writes one family with a sample, an alert, a message, and a threshold alert whose delivery stays
// queued (no outbox runs here). Returns the identity's token and what it sees.
const seed = (config: DbConfig) =>
	Effect.scoped(
		Effect.gen(function* () {
			const family = yield* openFamilyDb(config);
			yield* callDb(family, (c) =>
				c.reducers.createFamily({ name: "Drill family" }),
			);
			const [home] = readFamilyRecords(family).families;
			if (home === undefined) throw new Error("family was not created");
			const familyId = BigInt(home.id);
			yield* callDb(family, (c) =>
				c.reducers.recordSample({
					familyId,
					metric: "heart_rate",
					value: 72,
					unit: "bpm",
					sourceTime: Timestamp.fromDate(new Date("2026-01-01T08:00:00Z")),
					source: "synthetic-drill",
					synthetic: true,
					quality: { tag: "Unvalidated" },
				}),
			);
			yield* callDb(family, (c) =>
				c.reducers.raiseAlert({
					familyId,
					sampleId: undefined,
					summary: "Drill alert",
				}),
			);
			yield* callDb(family, (c) =>
				c.reducers.sendMessage({
					familyId,
					clientId: "drill-message",
					body: "Drill message",
				}),
			);
			yield* callDb(family, (c) =>
				c.reducers.setAlertThreshold({
					familyId,
					metric: "heart_rate",
					direction: { tag: "Above" },
					limit: 110,
					unit: "bpm",
					maxAgeSeconds: 300,
				}),
			);
			yield* callDb(family, (c) =>
				c.reducers.recordSample({
					familyId,
					metric: "heart_rate",
					value: 140,
					unit: "bpm",
					sourceTime: Timestamp.fromDate(new Date(Date.now() - 1000)),
					source: "synthetic-drill",
					synthetic: true,
					quality: { tag: "Validated" },
				}),
			);
			const seen = snapshot(family);
			if (!seen.alerts.some((a) => a.delivery?.status === "queued"))
				throw new Error("the threshold alert has no queued delivery");
			return { token: family.token, seen };
		}),
	);

const read = (config: DbConfig) =>
	Effect.scoped(openFamilyDb(config).pipe(Effect.map(snapshot)));

const servers: ChildProcess[] = [];
try {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	mkdirSync(join(original, "jwt"), { recursive: true });
	writeFileSync(keys(original).priv, privateKey, { mode: 0o600 });
	writeFileSync(keys(original).pub, publicKey);
	const first = await start(original, port);
	servers.push(first.server);
	execFileSync(
		"spacetime",
		[
			...cli,
			"publish",
			"--server",
			first.url,
			"--module-path",
			join(repo, "spacetimedb"),
			"--anonymous",
			"--yes",
			database,
		],
		{ stdio: "ignore" },
	);
	const config = { uri: `ws://127.0.0.1:${port}`, database };
	const { token, seen: records } = await Effect.runPromise(seed(config));
	console.log("seeded:", JSON.stringify(records, null, 2));

	// Crash: SIGKILL gives the database no chance to flush, then restart on the same directory.
	await stop(first.server, "SIGKILL");
	const second = await start(original, port);
	servers.push(second.server);
	const afterCrash = await Effect.runPromise(read({ ...config, token }));
	if (!isDeepStrictEqual(afterCrash, records))
		throw new Error("rows changed across the crash restart");
	console.log("crash restart: every seeded row is present");

	// Cold backup: stop cleanly, then archive the whole data directory.
	await stop(second.server, "SIGTERM");
	execFileSync("tar", ["-czf", archive, "-C", original, "."]);
	console.log(`backup: ${archive}`);

	// Restore into a new directory on a new port; the original directory stays untouched.
	execFileSync("mkdir", [restored]);
	execFileSync("tar", ["-xzf", archive, "-C", restored]);
	const third = await start(restored, port + 1);
	servers.push(third.server);
	const back = await Effect.runPromise(
		read({ uri: `ws://127.0.0.1:${port + 1}`, database, token }),
	);
	console.log("restored:", JSON.stringify(back, null, 2));
	if (!isDeepStrictEqual(back, records))
		throw new Error("restored rows differ from the seeded rows");
	console.log("drill: ok, restored rows equal the seeded rows");
} finally {
	for (const server of servers) if (server.exitCode === null) server.kill();
	rmSync(work, { recursive: true, force: true });
}
