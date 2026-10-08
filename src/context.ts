import { randomBytes } from 'node:crypto';
import type { ApiClient, ApiStep } from './api.js';
import { expect, type Expectation } from './expect.js';
import { get, type HttpAnswer } from './http.js';

/** What a check is given, and nothing more: no mesh calls, no database writes. */
export interface CheckContext {
    /** The api, as the check's identity, through its public gateway, in the check organization. */
    readonly api: ApiClient;
    /** What a visitor gets, from outside. */
    readonly http: { get(url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<HttpAnswer> };
    /** The organization the check runs in. */
    readonly org: { readonly id: string; readonly slug: string };
    /** An undo step, run after the check (last first), whether it passed or not. */
    cleanup(step: () => Promise<unknown>): void;
    /** A name no other run uses: `e2e-7f3a91`. */
    unique(prefix: string): string;
    expect(actual: unknown, what?: string): Expectation;
    /** A line in the check's report. */
    note(line: string): void;
    /** Waits until `probe` gives a value (anything but undefined or false), or fails naming `what`. */
    until<T>(what: string, probe: () => Promise<T | undefined | false>, within?: number): Promise<T>;
}

export interface ContextRecord {
    readonly steps: ApiStep[];
    readonly notes: string[];
    readonly cleanups: Array<() => Promise<unknown>>;
}

export function makeContext(api: ApiClient, org: { id: string; slug: string }, record: ContextRecord): CheckContext {
    return {
        api,
        http: { get },
        org,
        cleanup: (step) => {
            record.cleanups.push(step);
        },
        unique: (prefix) => `${prefix}-${randomBytes(3).toString('hex')}`,
        expect,
        note: (line) => {
            record.notes.push(line);
        },
        until: async (what, probe, within = 60_000) => {
            const started = Date.now();
            for (;;) {
                const value = await probe();
                if (value !== undefined && value !== false) return value;
                if (Date.now() - started > within) throw new Error(`waited ${Math.round(within / 1000)} s for ${what}`);
                await new Promise((r) => setTimeout(r, 1000));
            }
        },
    };
}
