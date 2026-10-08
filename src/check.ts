import type { CheckContext } from './context.js';

/** Who a check calls as: names in the config's `identities`. */
export type IdentityName = string;

export interface CheckOptions {
    /** The identity its api calls are made as (default: `operator`). */
    readonly as?: IdentityName;
    /** When it runs: `after-deploy:<part>`, `hourly`, or anything the config's runs name. */
    readonly tags?: readonly string[];
    /** How long it may take in all, its cleanup not counted: `30s`, `10m` (default `2m`). */
    readonly timeout?: string;
}

export interface Check {
    readonly name: string;
    readonly options: CheckOptions;
    readonly run: (t: CheckContext) => Promise<void>;
}

/**
 * A live check: a small scenario, written like a test, run against the real api. It does what a
 * person does (through the api, from outside), and undoes what it made with `t.cleanup`.
 *
 *     export default check('a provider keeps its default', { tags: ['after-deploy:certs'] }, async (t) => { ... });
 */
export function check(name: string, options: CheckOptions, run: (t: CheckContext) => Promise<void>): Check {
    return { name, options, run };
}

/** `30s`, `10m`, `1h`, or plain milliseconds. */
export function durationMs(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;

    const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
    if (match === null) throw new Error(`Not a duration: "${value}" (use 30s, 10m, 1h)`);

    const factor = UNITS.get(match[2] ?? 'ms');
    if (factor === undefined) throw new Error(`Not a duration: "${value}"`);

    return Number(match[1]) * factor;
}

const UNITS = new Map([['ms', 1], ['s', 1000], ['m', 60_000], ['h', 3_600_000]]);
