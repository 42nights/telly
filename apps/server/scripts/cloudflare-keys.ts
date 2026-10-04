// Shared Telly keys in the Cloudflare account Secrets Store. See docs/cloudflare-keys.md.
//   bun run secrets:push <env-file>  upload the server keys in a private env file, with your own
//                                    member API token from ~/.config/telly/cloudflare.env
//   bun run secrets:pull [dest]      write every stored key to dest (default apps/server/.env.local)
//                                    through the telly-secrets Worker, with the service token in
//                                    ~/.config/telly/secrets-pull.env
// Credentials and values come only from mode-600 files, never arguments or the environment.
// Output names keys, never values.
import { createHash } from "node:crypto";
import {
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = "telly-secrets";
const comment = "telly";
const config = join(homedir(), ".config/telly");
const schemaPath = fileURLToPath(new URL("../.env.schema", import.meta.url));
// Unquoted dotenv values that every parser reads the same way. Provider keys and tokens fit.
const safeValue = /^[\w.~+/=:-]+$/;

/** Server keys: items of apps/server/.env.schema whose comment block has no `@public`. */
export const secretNames = (schema: string): ReadonlySet<string> => {
	const names = new Set<string>();
	let block = "";
	for (const line of schema.split("\n")) {
		if (line.startsWith("#")) {
			block += line;
			continue;
		}
		const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
		if (name && !block.includes("@public")) names.add(name);
		block = "";
	}
	return names;
};

/** `NAME=value` lines of a mode-600 file. Blank and `#` lines are skipped. */
const readPrivate = (path: string): Map<string, string> => {
	if ((statSync(path).mode & 0o777) !== 0o600)
		throw new Error(`${path} must be mode 600`);
	return parseEnv(readFileSync(path, "utf8"));
};

/** Parses `NAME=value` lines; other lines, such as blanks and `#` comments, are skipped. */
export const parseEnv = (text: string): Map<string, string> => {
	const env = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
		if (match?.[1] !== undefined) env.set(match[1], match[2] ?? "");
	}
	return env;
};

/** The keys of `env` that are server keys, each checked to be non-empty and safe to write unquoted. */
export const serverKeys = (
	env: ReadonlyMap<string, string>,
	names: ReadonlySet<string>,
): Map<string, string> => {
	const keys = new Map<string, string>();
	for (const [name, value] of env) {
		if (!names.has(name)) continue;
		if (!safeValue.test(value))
			throw new Error(
				`${name} is empty or has characters other than letters, digits, and ._~+/=:-`,
			);
		keys.set(name, value);
	}
	return keys;
};

const need = (env: ReadonlyMap<string, string>, name: string, file: string) => {
	const value = env.get(name);
	if (!value) throw new Error(`Set ${name} in ${file}`);
	return value;
};

type Secret = { id: string; name: string; comment?: string; modified?: string };

const push = async (source: string) => {
	const credsFile = join(config, "cloudflare.env");
	const creds = readPrivate(credsFile);
	const account = need(creds, "CLOUDFLARE_ACCOUNT_ID", credsFile);
	const token = need(creds, "CLOUDFLARE_API_TOKEN", credsFile);
	const names = secretNames(readFileSync(schemaPath, "utf8"));
	const file = readPrivate(source);
	const keys = serverKeys(file, names);
	const skipped = [...file.keys()].filter((name) => !names.has(name));
	if (skipped.length > 0)
		console.log(`Skipped, not server keys: ${skipped.join(", ")}`);

	const api = async <T>(
		method: string,
		path: string,
		body?: FormData | object,
	) => {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body && !(body instanceof FormData)
						? { "Content-Type": "application/json" }
						: {}),
				},
				...(body === undefined
					? {}
					: { body: body instanceof FormData ? body : JSON.stringify(body) }),
			},
		);
		const out = (await response.json()) as {
			success: boolean;
			errors: unknown;
			result: T;
		};
		if (!out.success)
			throw new Error(`${method} ${path}: ${JSON.stringify(out.errors)}`);
		return out.result;
	};

	// The Worker checks the Access JWT against these, so they are looked up, never hand-set.
	const { auth_domain: team } = await api<{ auth_domain: string }>(
		"GET",
		"/access/organizations",
	);
	const app = (
		await api<{ name: string; aud: string }[]>("GET", "/access/apps")
	).find((a) => a.name === worker);
	const pull = (
		await api<{ name: string; client_id: string }[]>(
			"GET",
			"/access/service_tokens",
		)
	).find((t) => t.name === `${worker}-pull`);
	if (!app || !pull)
		throw new Error(
			`Create the Access app ${worker} and service token ${worker}-pull first (docs/cloudflare-keys.md)`,
		);
	const [store] = await api<{ id: string }[]>("GET", "/secrets_store/stores");
	if (!store)
		throw new Error(
			"Create the account Secrets Store first (docs/cloudflare-keys.md)",
		);
	const secrets = `/secrets_store/stores/${store.id}/secrets`;
	// ponytail: one page; an account holds at most 100 secrets during the Secrets Store beta.
	const list = () => api<Secret[]>("GET", `${secrets}?per_page=100`);
	const existing = new Map((await list()).map((s) => [s.name, s]));

	const foreign = [...keys.keys()].filter(
		(name) => existing.has(name) && existing.get(name)?.comment !== comment,
	);
	if (foreign.length > 0)
		throw new Error(
			`Not Telly secrets, refusing to overwrite: ${foreign.join(", ")}`,
		);
	const created = [...keys].filter(([name]) => !existing.has(name));
	if (created.length > 0)
		await api(
			"POST",
			secrets,
			created.map(([name, value]) => ({
				name,
				value,
				scopes: ["workers"],
				comment,
			})),
		);
	for (const [name, value] of keys) {
		const id = existing.get(name)?.id;
		if (id)
			await api("PATCH", `${secrets}/${id}`, {
				value,
				scopes: ["workers"],
				comment,
			});
	}

	// Bind every Telly secret, including ones other members uploaded.
	const stored = (await list()).filter(
		(s) => s.comment === comment && names.has(s.name),
	);
	const form = new FormData();
	form.append(
		"metadata",
		new Blob(
			[
				JSON.stringify({
					main_module: "index.js",
					compatibility_date: "2026-09-01",
					observability: { enabled: false },
					logpush: false,
					bindings: [
						...stored.map((s) => ({
							type: "secrets_store_secret",
							name: s.name,
							store_id: store.id,
							secret_name: s.name,
						})),
						{ type: "plain_text", name: "team_domain", text: team },
						{ type: "plain_text", name: "aud", text: app.aud },
						{ type: "plain_text", name: "client_id", text: pull.client_id },
					],
				}),
			],
			{ type: "application/json" },
		),
	);
	const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
		readFileSync(
			new URL("./cloudflare-keys-worker.ts", import.meta.url),
			"utf8",
		),
	);
	form.append(
		"index.js",
		new Blob([code], { type: "application/javascript+module" }),
		"index.js",
	);
	await api("PUT", `/workers/scripts/${worker}`, form);
	// A file without server keys only redeploys the Worker, such as after a pull token change.
	console.log(`Uploaded: ${[...keys.keys()].join(", ") || "none"}`);
	console.log(`Worker ${worker} binds ${stored.length} Telly secrets:`);
	for (const s of stored)
		console.log(`  ${s.name}  modified ${s.modified ?? "?"}`);
};

const pull = async (dest: string) => {
	const credsFile = join(config, "secrets-pull.env");
	const creds = readPrivate(credsFile);
	const url = need(creds, "TELLY_SECRETS_URL", credsFile);
	const response = await fetch(url, {
		headers: {
			"CF-Access-Client-Id": need(
				creds,
				"TELLY_SECRETS_ACCESS_CLIENT_ID",
				credsFile,
			),
			"CF-Access-Client-Secret": need(
				creds,
				"TELLY_SECRETS_ACCESS_CLIENT_SECRET",
				credsFile,
			),
		},
		// Access answers a rejected token with a login redirect; treat it as the failure it is.
		redirect: "manual",
	});
	if (response.status !== 200)
		throw new Error(
			`HTTP ${response.status} from ${url}; ${dest} left unchanged`,
		);
	const pulled = parseEnv(await response.text());
	const names = secretNames(readFileSync(schemaPath, "utf8"));
	const unknown = [...pulled.keys()].filter((name) => !names.has(name));
	if (unknown.length > 0)
		throw new Error(
			`Not server keys: ${unknown.join(", ")}; ${dest} left unchanged`,
		);
	const keys = serverKeys(pulled, names);
	if (keys.size === 0)
		throw new Error(`No keys stored; ${dest} left unchanged`);
	const text = [
		`# Written by \`bun run secrets:pull\` from ${url}. The next pull replaces this file.`,
		...[...keys].map(([name, value]) => `${name}=${value}`),
		`TELLY_REQUIRED_KEYS=${[...keys.keys()].join(",")}`,
		"",
	].join("\n");
	const tmp = `${dest}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		renameSync(tmp, dest);
	} finally {
		rmSync(tmp, { force: true });
	}
	const sha = createHash("sha256").update(text).digest("hex");
	console.log(
		`Wrote ${dest} (mode 600, sha256 ${sha}): ${[...keys.keys()].join(", ")}`,
	);
};

if (import.meta.main) {
	const [command, path] = process.argv.slice(2);
	try {
		if (command === "push" && path) await push(path);
		else if (command === "pull")
			await pull(path ?? join(import.meta.dir, "../.env.local"));
		else
			throw new Error(
				"Usage: cloudflare-keys.ts push <env-file> | pull [dest]",
			);
	} catch (error) {
		// Messages name keys and files only; values never reach an error.
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
