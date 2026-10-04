import { AwsClient } from "aws4fetch";
import { ApiFailure } from "../http";

// Cloudflare R2 through its S3-compatible API (https://developers.cloudflare.com/r2/api/s3/api/).
// The bucket stays private: every object is read and written by this server with an API token
// scoped to the one bucket ("Object Read & Write"). Clients never get a bucket URL.

export type R2Config = {
	/** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. */
	readonly endpoint: string;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
};

export type StoredObject = {
	readonly key: string;
	readonly size: number;
	readonly lastModified: string;
};

export type R2Bucket = {
	readonly put: (key: string, body: Uint8Array, type: string) => Promise<void>;
	/** `null` when no object has this key. */
	readonly get: (key: string) => Promise<Response | null>;
	/** Every object whose key starts with `prefix`. */
	readonly list: (prefix: string) => Promise<StoredObject[]>;
};

const failed = (action: string, status: number) =>
	new ApiFailure(
		status === 429 || status >= 500 ? "unavailable" : "upstream_error",
		`PDF storage could not ${action}: HTTP ${status}`,
	);

const tag = (xml: string, name: string) =>
	xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

export const r2Bucket = (config: R2Config): R2Bucket => {
	// R2 takes the region "auto" (https://developers.cloudflare.com/r2/api/s3/api/).
	const client = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: "s3",
		region: "auto",
		retries: 2,
	});
	const base = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}`;
	// Callers build keys from ids, digits, ".", "-", and "/" only, so no part needs escaping.
	const url = (key: string) => `${base}/${key}`;
	const send = async (input: string, init?: RequestInit) => {
		try {
			return await client.fetch(input, init);
		} catch {
			throw new ApiFailure("unavailable", "PDF storage is not reachable");
		}
	};

	return {
		put: async (key, body, type) => {
			const response = await send(url(key), {
				method: "PUT",
				body,
				headers: { "Content-Type": type },
			});
			await response.body?.cancel();
			if (!response.ok) throw failed("save the PDF", response.status);
		},
		get: async (key) => {
			const response = await send(url(key));
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw failed("read the PDF", response.status);
			return response;
		},
		list: async (prefix) => {
			const objects: StoredObject[] = [];
			let token: string | undefined;
			do {
				const query = new URLSearchParams({ "list-type": "2", prefix });
				if (token !== undefined) query.set("continuation-token", token);
				const response = await send(`${base}?${query}`);
				const xml = await response.text();
				if (!response.ok) throw failed("list the PDFs", response.status);
				for (const [, entry = ""] of xml.matchAll(
					/<Contents>([\s\S]*?)<\/Contents>/g,
				)) {
					const key = tag(entry, "Key");
					const size = Number(tag(entry, "Size"));
					const lastModified = tag(entry, "LastModified");
					if (key === undefined || lastModified === undefined)
						throw failed("list the PDFs", 502);
					objects.push({ key, size, lastModified });
				}
				const next = tag(xml, "NextContinuationToken");
				token = tag(xml, "IsTruncated") === "true" ? next : undefined;
			} while (token !== undefined);
			return objects;
		},
	};
};
