/**
 * RFC 6265 cookie-header parsing shared by the REST middleware and the
 * realtime handshake (which has no cookie-parser instance).
 */
export function parseCookieHeader(raw: string | undefined): Record<string, string> {
    if (!raw) {
        return {};
    }

    const cookies: Record<string, string> = {};
    for (const segment of raw.split(';')) {
        const [name, ...rest] = segment.trim().split('=');
        if (!name || rest.length === 0) {
            continue;
        }
        try {
            cookies[name] = decodeURIComponent(rest.join('=').trim());
        } catch {
            // Malformed escape sequence: keep the raw value rather than
            // dropping the whole header.
            cookies[name] = rest.join('=');
        }
    }
    return cookies;
}
