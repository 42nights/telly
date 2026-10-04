import { AwsClient } from "aws4fetch";
import { ApiFailure } from "../http";

// Cloudflare R2 through its S3-compatible API (https://developers.cloudflare.com/r2/api/s3/api/).
// The bucket stays private: this server writes and lists with an API token scoped to the one bucket
// ("Object Read & Write"), and a download is a short-lived presigned GET link for one object.

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
	readonly exists: (key: string) => Promise<boolean>;
	/** A GET link for one object that expires after `seconds`; the browser saves it as `filename`. */
	readonly presign: (
		key: string,
		filename: string,
		seconds: number,
	) => Promise<string>;
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
		exists: async (key) => {
			const response = await send(url(key), { method: "HEAD" });
			if (response.status === 404) return false;
			if (!response.ok) throw failed("read the PDF", response.status);
			return true;
		},
		presign: async (key, filename, seconds) => {
			const link = new URL(url(key));
			link.searchParams.set("X-Amz-Expires", String(seconds));
			link.searchParams.set(
				"response-content-disposition",
				`attachment; filename="${filename}"`,
			);
			const signed = await client.sign(link.toString(), {
				method: "GET",
				aws: { signQuery: true },
			});
			return signed.url;
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
