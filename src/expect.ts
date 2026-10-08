/**
 * The assertions a check makes. Few on purpose: each failure says what was expected and what came,
 * in words an operator reads in an alert.
 */
import { isDeepStrictEqual, inspect } from 'node:util';

export class CheckFailed extends Error {}

const show = (value: unknown): string => inspect(value, { depth: 4, breakLength: 120 });

export interface Expectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(part: string): void;
    toMatchObject(expected: Readonly<Record<string, unknown>>): void;
    toBeDefined(): void;
    toBeTruthy(): void;
}

export function expect(actual: unknown, what?: string): Expectation {
    const fail = (message: string): never => {
        throw new CheckFailed(what !== undefined ? `${what}: ${message}` : message);
    };

    return {
        toBe: (expected) => {
            if (!Object.is(actual, expected)) fail(`expected ${show(expected)}, got ${show(actual)}`);
        },
        toEqual: (expected) => {
            if (!isDeepStrictEqual(actual, expected)) fail(`expected ${show(expected)}, got ${show(actual)}`);
        },
        toContain: (part) => {
            if (typeof actual !== 'string' || !actual.includes(part)) fail(`expected to contain ${show(part)}, got ${show(typeof actual === 'string' ? actual.slice(0, 300) : actual)}`);
        },
        toMatchObject: (expected) => {
            const missing = Object.entries(expected).filter(([k, v]) => !(typeof actual === 'object' && actual !== null && k in actual && isDeepStrictEqual(Reflect.get(actual, k), v)));
            if (missing.length > 0) fail(`expected ${missing.map(([k, v]) => `${k}: ${show(v)}`).join(', ')}, got ${show(actual)}`);
        },
        toBeDefined: () => {
            if (actual === undefined) fail('expected a value, got undefined');
        },
        toBeTruthy: () => {
            if (!actual) fail(`expected something true, got ${show(actual)}`);
        },
    };
}
