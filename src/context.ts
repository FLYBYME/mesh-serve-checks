import { randomBytes } from 'node:crypto';
import type { ApiClient, ApiStep } from './api.js';
import { exec, type ExecOptions, type ExecResult } from './exec.js';
import { expect, type Expectation } from './expect.js';
import { get, type HttpAnswer } from './http.js';

/** What a check is given, and nothing more: no mesh calls, no database writes. */
export interface CheckContext {
    /** The api, as the check's identity, through its public gateway, in the check organization. */
    readonly api: ApiClient;
    /** What a visitor gets, from outside. */
    readonly http: { get(url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<HttpAnswer> };
    /** A command (ssh, an install script, a provider's CLI): fails the check on a non-zero exit unless `allowFailure`. */
    exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult>;
    /** The organization the check runs in. */
    readonly org: { readonly id: string; readonly slug: string };
    /** An undo step, run right after this check (last first), whether it passed or not. */
    cleanup(step: () => Promise<unknown>): void;
    /**
     * An undo step for what checks after this one stand on (droplets, a test customer): run once,
     * after every check of the run, last first -- even when a later check failed or the run timed out.
     */
    cleanupAtEnd(step: () => Promise<unknown>): void;
    /** Hands a value to the checks that need this one (`t.need(key, parse)` there). */
    provide(key: string, value: unknown): void;
    /** A value a check this one needs provided, parsed into what this check relies on. */
    need<T>(key: string, parse: (value: unknown) => T): T;
    /** A name no other run uses: `e2e-7f3a91`. */
    unique(prefix: string): string;
    expect(actual: unknown, what?: string): Expectation;
    /** A line in the check's report. */
    note(line: string): void;
    /** Waits until `probe` gives a value (anything but undefined or false), or fails naming `what`. */
    until<T>(what: string, probe: () => Promise<T | undefined | false>, within?: number, every?: number): Promise<T>;
}

export interface ContextRecord {
    readonly steps: ApiStep[];
    readonly notes: string[];
    readonly cleanups: Array<() => Promise<unknown>>;
}

export interface RunScope {
    /** Values checks provide, for the checks that need them. */
    readonly values: Map<string, unknown>;
    /** Undo steps for the end of the run. */
    readonly atEnd: Array<() => Promise<unknown>>;
}

export function makeContext(api: ApiClient, org: { id: string; slug: string }, record: ContextRecord, scope: RunScope): CheckContext {
    return {
        api,
        http: { get },
        exec,
        org,
        cleanup: (step) => {
            record.cleanups.push(step);
        },
        cleanupAtEnd: (step) => {
            scope.atEnd.push(step);
        },
        provide: (key, value) => {
            scope.values.set(key, value);
        },
        need: (key, parse) => {
            if (!scope.values.has(key)) throw new Error(`nothing provided "${key}": a check this one needs did not run`);
            return parse(scope.values.get(key));
        },
        unique: (prefix) => `${prefix}-${randomBytes(3).toString('hex')}`,
        expect,
        note: (line) => {
            record.notes.push(line);
        },
        until: async (what, probe, within = 60_000, every = 1000) => {
            const started = Date.now();
            for (;;) {
                const value = await probe();
                if (value !== undefined && value !== false) return value;
                if (Date.now() - started > within) throw new Error(`waited ${Math.round(within / 1000)} s for ${what}`);
                await new Promise((r) => setTimeout(r, every));
            }
        },
    };
}
