/**
 * What a visitor gets: one request from outside, by real DNS, with the certificate judged as a
 * browser would. Redirects are reported, not followed, so a check can say where they lead.
 */
import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';

export interface Certificate {
    /** Trusted, for this name, and in date -- what a browser accepts without a warning. */
    readonly valid: boolean;
    readonly subject?: string;
    readonly issuer?: string;
    readonly validTo?: string;
    /** Why not, when it is not valid (the TLS library's word for it). */
    readonly error?: string;
}

export interface HttpAnswer {
    readonly url: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly location?: string;
    readonly certificate?: Certificate;
}

export function get(url: string, options: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<HttpAnswer> {
    const target = new URL(url);
    const secure = target.protocol === 'https:';

    return new Promise((resolve, reject) => {
        const onResponse = (res: http.IncomingMessage): void => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
                }

                resolve({
                    url,
                    status: res.statusCode ?? 0,
                    headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                    ...(res.headers.location !== undefined ? { location: res.headers.location } : {}),
                    ...(secure ? { certificate: certificateOf(res.socket, target.hostname) } : {}),
                });
            });
        };

        // Judged, not enforced: a bad certificate is an answer to report, not a failed request.
        const req = secure
            ? https.get(target, { rejectUnauthorized: false, headers: options.headers ?? {} }, onResponse)
            : http.get(target, { headers: options.headers ?? {} }, onResponse);
        req.setTimeout(options.timeoutMs ?? 15_000, () => req.destroy(new Error(`${url}: no answer in ${options.timeoutMs ?? 15_000} ms`)));
        req.on('error', reject);
    });
}

function certificateOf(socket: unknown, hostname: string): Certificate {
    if (!isTlsSocket(socket)) return { valid: false, error: 'not a TLS connection' };

    const peer = socket.getPeerCertificate();
    const subject = typeof peer.subject?.CN === 'string' ? peer.subject.CN : undefined;
    const issuer = [peer.issuer?.O, peer.issuer?.CN].filter((p): p is string => typeof p === 'string').join(', ') || undefined;
    const error = socket.authorizationError === null || socket.authorizationError === undefined ? undefined : String(socket.authorizationError);

    return {
        valid: socket.authorized === true && error === undefined,
        ...(subject !== undefined ? { subject } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        ...(typeof peer.valid_to === 'string' ? { validTo: peer.valid_to } : {}),
        ...(error !== undefined ? { error } : socket.authorized === true ? {} : { error: `not trusted for ${hostname}` }),
    };
}

function isTlsSocket(socket: unknown): socket is TLSSocket {
    return typeof socket === 'object' && socket !== null && 'getPeerCertificate' in socket && typeof socket.getPeerCertificate === 'function';
}
