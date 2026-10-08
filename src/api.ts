/**
 * The api, called as a person's client calls it: `/api/_describe` once, then each call by its key
 * (`certProvider.create`) at the method and path the api says, through its public gateway.
 */
import { randomBytes } from 'node:crypto';

export interface DescribedCall {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly gate?: string;
    readonly input?: { readonly properties?: Readonly<Record<string, unknown>> };
}

export interface ApiStep {
    readonly call: string;
    readonly status: number;
    readonly ms: number;
    /** The node that answered (the gateway's x-mesh-node). */
    readonly node?: string;
}

export class ApiCallError extends Error {
    constructor(readonly call: string, readonly status: number, message: string, readonly body: unknown) {
        super(`${call}: ${status} ${message}`);
    }
}

export interface ApiClientOptions {
    readonly origin: string;
    readonly token?: string;
    /** The organization the calls run in: given as `tenantId` on every call (the gateway's operator override). */
    readonly organization?: string;
    /** W3C trace id of the run: every call is a span of it, so its effects can be found. */
    readonly traceId?: string;
    readonly onStep?: (step: ApiStep) => void;
}

export class ApiClient {
    private calls: Map<string, DescribedCall> | undefined;

    constructor(private readonly options: ApiClientOptions) {}

    /** What the api exposes, read once. */
    async describe(): Promise<Map<string, DescribedCall>> {
        if (this.calls !== undefined) return this.calls;

        const res = await fetch(`${this.options.origin}/api/_describe`);
        if (!res.ok) throw new Error(`${this.options.origin}/api/_describe answered ${res.status}`);

        const body: unknown = await res.json();
        const list = typeof body === 'object' && body !== null && 'calls' in body && Array.isArray(body.calls) ? body.calls : [];
        this.calls = new Map(list.filter(isDescribedCall).map((c) => [c.key, c]));

        return this.calls;
    }

    /** A call whose answer is parsed into what the check relies on (a zod schema's `parse` will do). */
    async callParsed<T>(key: string, input: Record<string, unknown>, parse: (answer: unknown) => T): Promise<T> {
        return parse(await this.call(key, input));
    }

    /** One call by its key, as this client's identity, in its organization: the answer as the api sent it. */
    async call(key: string, input: Record<string, unknown> = {}): Promise<unknown> {
        const described = (await this.describe()).get(key);
        if (described === undefined) throw new Error(`"${key}" is not exposed on ${this.options.origin}`);

        // On every call, not only those whose input names it: the gateway runs an operator's call in
        // the organization its input names, find and get included. Given only where the input listed
        // `tenantId`, a check's reads ran in the operator's own organization and found nothing.
        const params = this.options.organization !== undefined && input['tenantId'] === undefined
            ? { ...input, tenantId: this.options.organization }
            : input;

        const { path, rest } = fillPath(described.path, params);
        const method = described.method.toUpperCase();
        const headers: Record<string, string> = { traceparent: traceparent(this.options.traceId) };
        if (this.options.token !== undefined) headers['authorization'] = `Bearer ${this.options.token}`;

        let url = `${this.options.origin}/api${path}`;
        let body: string | undefined;
        if (method === 'GET' || method === 'DELETE') {
            const query = new URLSearchParams();
            for (const [k, v] of Object.entries(rest)) {
                if (v !== undefined) query.set(k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
            }
            if (query.size > 0) url += `?${query.toString()}`;
        } else {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(rest);
        }

        const started = Date.now();
        const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
        const text = await res.text();
        const node = res.headers.get('x-mesh-node');
        this.options.onStep?.({ call: key, status: res.status, ms: Date.now() - started, ...(node !== null ? { node } : {}) });

        const parsed: unknown = text === '' ? undefined : safeJson(text);
        if (!res.ok) throw new ApiCallError(key, res.status, messageOf(parsed) ?? res.statusText, parsed);

        return parsed;
    }
}

function isDescribedCall(value: unknown): value is DescribedCall {
    return typeof value === 'object' && value !== null
        && 'key' in value && typeof value.key === 'string'
        && 'method' in value && typeof value.method === 'string'
        && 'path' in value && typeof value.path === 'string';
}

/** `/cert_providers/:id` with `{ id: 'x', name: 'y' }`: the path filled, the rest left. */
export function fillPath(template: string, input: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
    const rest = { ...input };
    const path = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
        const value = rest[name];
        if (value === undefined) throw new Error(`${template}: no value for :${name}`);
        delete rest[name];
        return encodeURIComponent(String(value));
    });

    return { path, rest };
}

function traceparent(traceId: string | undefined): string {
    return `00-${traceId ?? randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function messageOf(body: unknown): string | undefined {
    if (typeof body === 'string') return body.slice(0, 300);
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') return body.message;
    return undefined;
}
