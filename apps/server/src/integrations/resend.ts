// Email through Resend (https://resend.com/docs/api-reference/emails/send-email). The free plan
// sends from `onboarding@resend.dev` to the Resend account owner only, until a domain is verified.

export type ResendConfig = {
	readonly apiKey: string;
	/** Such as `Telly <onboarding@resend.dev>`. */
	readonly from: string;
};

export type Mail = {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly attachment: {
		readonly filename: string;
		readonly content: Uint8Array;
	};
	/** Resend sends one email per key for 24 hours, so a retried request sends nothing more. */
	readonly idempotencyKey: string;
};

/** Resolves once the provider accepted the email. Rejects with a reason that can be shown to the family. */
export type Mailer = (mail: Mail) => Promise<void>;

export const resendMailer =
	(config: ResendConfig): Mailer =>
	async (mail) => {
		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				"Idempotency-Key": mail.idempotencyKey,
			},
			body: JSON.stringify({
				from: config.from,
				to: [mail.to],
				subject: mail.subject,
				text: mail.text,
				attachments: [
					{
						filename: mail.attachment.filename,
						content: Buffer.from(mail.attachment.content).toString("base64"),
					},
				],
			}),
			signal: AbortSignal.timeout(15_000),
		}).catch(() => {
			throw new Error(
				"The email service did not answer; the email may still arrive",
			);
		});
		if (response.ok) {
			await response.body?.cancel();
			return;
		}
		// Resend's error message says why, such as an unverified sender domain. It holds no key.
		const body = (await response.json().catch(() => null)) as {
			message?: unknown;
		} | null;
		const why =
			typeof body?.message === "string"
				? `: ${body.message.slice(0, 200)}`
				: "";
		throw new Error(
			`The email service refused the email (HTTP ${response.status})${why}`,
		);
	};
