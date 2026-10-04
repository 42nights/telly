// Runs the built server under Node, checks its real HTTP responses against the contracts, and checks
// that SIGTERM shuts it down. Run `bun run build` first. Usage: bun run smoke
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Health, Sources } from "@health/contracts";
import { Schema } from "effect";

const port = 3900 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const server = spawn("node", ["dist/index.mjs"], {
	cwd: new URL("../", import.meta.url),
	env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
	stdio: "inherit",
});

const get = async (path: string) => (await fetch(`${base}${path}`)).json();

try {
	let health: unknown;
	for (let attempt = 0; health === undefined; attempt++) {
		if (attempt === 50)
			throw new Error("server did not answer /health within 10 s");
		health = await get("/health").catch(() => undefined);
		if (health === undefined) await sleep(200);
	}
	Schema.decodeUnknownSync(Health)(health);
	const { sources } = Schema.decodeUnknownSync(Sources)(
		await get("/api/sources"),
		{
			onExcessProperty: "error",
		},
	);
	if (sources.find((s) => s.source === "noop")?.status !== "not_connected") {
		throw new Error("Healer S.I. must be reported as not_connected");
	}
} finally {
	server.kill("SIGTERM");
}
const timeout = setTimeout(() => {
	console.error("smoke: server did not exit within 5 s of SIGTERM");
	process.exit(1);
}, 5000);
await once(server, "exit");
clearTimeout(timeout);
console.log("smoke: ok");
