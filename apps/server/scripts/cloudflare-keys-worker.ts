// Cloudflare Worker `telly-secrets`: answers GET with one `NAME=value` line per Telly secret in the
// account Secrets Store. Secrets Store gives values only to a Worker binding, so this is the one way
// the Node server receives them (docs/cloudflare-keys.md). Cloudflare Access guards the hostname with the
// `telly-secrets-pull` service token; this code re-verifies the Access JWT so a misconfigured Access
// app still fails closed. Never log request data or secret values here.
// `bun run secrets:push` uploads this file with plain-text bindings `team_domain`
// (<team>.cloudflareaccess.com), `aud` (the Access app AUD tag), and `client_id` (the service
// token's client id), plus one Secrets Store binding per secret, named after its variable.
// Adapted from undeemed/code-factory workers/fleet-secrets (MIT).

import type { webcrypto } from "node:crypto";

type SecretBinding = { readonly get: () => Promise<string> };
type WorkerEnv = Readonly<Record<string, unknown>> & {
	readonly team_domain?: string;
	readonly aud?: string;
	readonly client_id?: string;
};
type Jwk = webcrypto.JsonWebKey & { readonly kid?: string };

const headers = { "Cache-Control": "no-store" };
const deny = (status = 403) => new Response(null, { status, headers });
const bytes = (s: string) =>
	Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
		c.charCodeAt(0),
	);
const json = (s: string): Record<string, unknown> =>
	JSON.parse(new TextDecoder().decode(bytes(s)));
const isSecret = (value: unknown): value is SecretBinding =>
	typeof (value as Partial<SecretBinding> | null)?.get === "function";

const authorized = async (request: Request, env: WorkerEnv) => {
	const [head = "", body = "", sig = "", extra] = (
		request.headers.get("Cf-Access-Jwt-Assertion") ?? ""
	).split(".");
	if (!sig || extra !== undefined) return false;
	const { alg, kid } = json(head);
	if (alg !== "RS256") return false;
	// Fetched per request so Access key rotation needs no redeploy.
	const certs = await fetch(`https://${env.team_domain}/cdn-cgi/access/certs`);
	const { keys } = (await certs.json()) as { keys: Jwk[] };
	const jwk = keys.find((k) => k.kid === kid);
	if (!jwk) return false;
	const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	const key = await crypto.subtle.importKey("jwk", jwk, algo, false, [
		"verify",
	]);
	const signed = new TextEncoder().encode(`${head}.${body}`);
	if (!(await crypto.subtle.verify(algo, key, bytes(sig), signed)))
		return false;
	const claims = json(body);
	const now = Date.now() / 1000;
	return (
		claims.iss === `https://${env.team_domain}` &&
		Boolean(env.aud) &&
		[claims.aud].flat().includes(env.aud) &&
		Number(claims.exp) > now &&
		Number(claims.nbf ?? 0) <= now &&
		Boolean(env.client_id) &&
		claims.common_name === env.client_id
	);
};

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		if (request.method !== "GET") return deny();
		if (!(await authorized(request, env).catch(() => false))) return deny();
		try {
			let text = "";
			for (const name of Object.keys(env).sort()) {
				const binding = env[name];
				if (isSecret(binding)) text += `${name}=${await binding.get()}\n`;
			}
			return new Response(text, {
				headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
			});
		} catch {
			// Error text can quote secret material; answer without it.
			return deny(500);
		}
	},
};
