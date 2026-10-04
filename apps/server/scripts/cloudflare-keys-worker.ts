// Cloudflare Worker `telly-secrets`: answers GET with one `NAME=value` line per server key in the
// account Secrets Store. Secrets Store gives values only to a Worker binding, so this is the one way
// the Node server receives them (docs/cloudflare-keys.md). Only a request that carries the pull
// token in `X-Telly-Pull-Token` gets an answer. Not `Authorization`: requests from a Cloudflare
// Container arrive without it. Never log request data or secret values here.
// `bun run secrets:push` uploads this file with one Secrets Store binding per server key, named
// after its variable, plus `pull_token`, bound to the store secret TELLY_SECRETS_PULL_TOKEN.

type SecretBinding = { readonly get: () => Promise<string> };
type WorkerEnv = Readonly<Record<string, unknown>>;

const headers = { "Cache-Control": "no-store" };
const deny = (status = 403) => new Response(null, { status, headers });
const isSecret = (value: unknown): value is SecretBinding =>
	typeof (value as Partial<SecretBinding> | null)?.get === "function";

/** Compares SHA-256 digests, so the time taken does not depend on where the inputs differ. */
const sameSecret = async (given: string, expected: string) => {
	const digest = async (s: string) =>
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
		);
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
};

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		if (request.method !== "GET") return deny();
		try {
			const token = env.pull_token;
			const given = request.headers.get("X-Telly-Pull-Token");
			if (!isSecret(token) || !given) return deny();
			const expected = await token.get();
			// A short token would make guessing practical; refuse to serve with one.
			if (expected.length < 32 || !(await sameSecret(given, expected)))
				return deny();
			let text = "";
			// Server keys are upper case; lower-case bindings, such as pull_token, are not served.
			for (const name of Object.keys(env).sort()) {
				const binding = env[name];
				if (/^[A-Z]/.test(name) && isSecret(binding))
					text += `${name}=${await binding.get()}\n`;
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
