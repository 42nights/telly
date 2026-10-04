/**
 * The lowercased `scheme://host[:port]` of an `http(s)` URL, or `null` for any other URL
 * (`tel:`, `mailto:`, `about:`) and for URLs with user info. React Native's `URL` class parses
 * origins with a loose regex, so the shell uses this exact one for its origin checks.
 */
export const originOf = (url: string) =>
	/^https?:\/\/[^/?#@\\]+(?=$|[/?#])/i.exec(url)?.[0].toLowerCase() ?? null;
