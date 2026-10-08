/**
 * A run: the config read, the checks found and filtered by tag, each run in turn in the check
 * organization, its cleanup always run (last first), and every result kept.
 */
import { randomBytes } from 'node:crypto';
import { glob, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ApiClient, type ApiStep } from './api.js';
import { durationMs, type Check } from './check.js';
import { isChecksConfig, type ChecksConfig, type Identity } from './config.js';
import { makeContext, type ContextRecord } from './context.js';

export interface CheckResult {
    readonly name: string;
    readonly file: string;
    readonly ok: boolean;
    readonly ms: number;
    readonly error?: string;
    readonly cleanupErrors: readonly string[];
    readonly steps: readonly ApiStep[];
    readonly notes: readonly string[];
}

export interface RunResult {
    readonly traceId: string;
    readonly startedAt: string;
    readonly api: string;
    readonly results: readonly CheckResult[];
}

export interface RunOptions {
    readonly tags?: readonly string[];
    /** Only checks whose name contains this. */
    readonly only?: string;
    readonly onResult?: (result: CheckResult) => void;
}

export async function loadConfig(file: string): Promise<{ config: ChecksConfig; dir: string }> {
    const absolute = path.resolve(file);
    const module: unknown = await tsImport(pathToFileURL(absolute).href, import.meta.url);
    const config = defaultExport(module);
    if (!isChecksConfig(config)) throw new Error(`${file}: its default export is not a checks config (defineConfig)`);

    return { config, dir: path.dirname(absolute) };
}

export async function run(configFile: string, options: RunOptions = {}): Promise<RunResult> {
    const { config, dir } = await loadConfig(configFile);
    const traceId = randomBytes(16).toString('hex');
    const startedAt = new Date().toISOString();
    const origin = new URL(config.api).origin;

    const checks = await findChecks(config, dir);
    const wanted = checks.filter(({ check }) =>
        (options.tags === undefined || options.tags.length === 0 || (check.options.tags ?? []).some((t) => options.tags?.includes(t)))
        && (options.only === undefined || check.name.includes(options.only)));

    const tokens = new Map<string, string>();
    const tokenFor = async (name: string): Promise<string> => {
        const known = tokens.get(name);
        if (known !== undefined) return known;

        const identity = config.identities[name];
        if (identity === undefined) throw new Error(`no identity "${name}" in the config`);

        const token = await resolveIdentity(identity, origin);
        tokens.set(name, token);
        return token;
    };

    const org = config.organization !== undefined
        ? await ensureOrganization(new ApiClient({ origin, token: await tokenFor('operator'), traceId }), config.organization)
        : { id: '', slug: '' };

    const results: CheckResult[] = [];
    for (const { check, file } of wanted) {
        const result = await runOne(check, path.relative(dir, file), origin, await tokenFor(check.options.as ?? 'operator'), org, traceId);
        results.push(result);
        options.onResult?.(result);
    }

    const out: RunResult = { traceId, startedAt, api: origin, results };
    if (config.report?.file !== undefined) await writeFile(path.resolve(dir, config.report.file), `${JSON.stringify(out, null, 2)}\n`);

    return out;
}

async function runOne(check: Check, file: string, origin: string, token: string, org: { id: string; slug: string }, traceId: string): Promise<CheckResult> {
    const record: ContextRecord = { steps: [], notes: [], cleanups: [] };
    const api = new ApiClient({ origin, token, traceId, ...(org.id !== '' ? { organization: org.id } : {}), onStep: (s) => record.steps.push(s) });
    const t = makeContext(api, org, record);
    const started = Date.now();
    const limit = durationMs(check.options.timeout, 120_000);

    let error: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            check.run(t),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`did not finish within ${check.options.timeout ?? '2m'}`)), limit);
            }),
        ]);
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
    } finally {
        clearTimeout(timer);
    }
    const ms = Date.now() - started;

    // Last made, first undone; one that fails does not stop the others.
    const cleanupErrors: string[] = [];
    for (const step of record.cleanups.reverse()) {
        try {
            await step();
        } catch (err) {
            cleanupErrors.push(err instanceof Error ? err.message : String(err));
        }
    }

    return {
        name: check.name, file, ok: error === undefined && cleanupErrors.length === 0, ms,
        ...(error !== undefined ? { error } : {}),
        cleanupErrors, steps: record.steps, notes: record.notes,
    };
}

async function findChecks(config: ChecksConfig, dir: string): Promise<Array<{ check: Check; file: string }>> {
    const files = new Set<string>();
    for (const pattern of config.checks) {
        for await (const file of glob(pattern, { cwd: dir })) files.add(path.resolve(dir, file));
    }

    const found: Array<{ check: Check; file: string }> = [];
    for (const file of [...files].sort()) {
        const module: unknown = await tsImport(pathToFileURL(file).href, import.meta.url);
        const check = defaultExport(module);
        if (!isCheck(check)) throw new Error(`${file}: its default export is not a check (check(...))`);
        found.push({ check, file });
    }

    return found;
}

function defaultExport(module: unknown): unknown {
    const first = typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined;
    // A TypeScript module loaded as CommonJS nests its own default one level down.
    return typeof first === 'object' && first !== null && 'default' in first && !('api' in first) && !('run' in first) ? first.default : first;
}

function isCheck(value: unknown): value is Check {
    return typeof value === 'object' && value !== null
        && 'name' in value && typeof value.name === 'string'
        && 'run' in value && typeof value.run === 'function'
        && 'options' in value && typeof value.options === 'object';
}

/** A token for an identity, without it ever being printed. */
async function resolveIdentity(identity: Identity, origin: string): Promise<string> {
    if ('env' in identity) {
        const token = process.env[identity.env];
        if (token === undefined || token === '') throw new Error(`the environment has no ${identity.env}`);
        return token;
    }

    const raw: unknown = JSON.parse(await readFile(path.join(os.homedir(), '.mesh-serve', 'session.json'), 'utf8'));
    const field = (key: string): unknown => (typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined);
    const apiUrl = field('apiUrl');
    const token = field('token');
    const expiresAt = field('expiresAt');

    if (typeof apiUrl !== 'string' || new URL(apiUrl).origin !== origin) throw new Error(`the mesh-serve session is for ${String(apiUrl)}, not ${origin}: mesh-serve switch, then login`);
    if (typeof token !== 'string') throw new Error('the mesh-serve session has no ticket: mesh-serve login');
    if (typeof expiresAt === 'number' && expiresAt < Date.now()) throw new Error('the mesh-serve session has expired: mesh-serve login');

    return token;
}

/** The check organization: found by its slug, or made, owned by the operator running the checks. */
async function ensureOrganization(api: ApiClient, wanted: { slug: string; name?: string }): Promise<{ id: string; slug: string }> {
    const idOf = (value: unknown): string | undefined => (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id : undefined);

    const found = await api.call('identity.organization.find', { query: { slug: wanted.slug }, limit: 1 });
    const existing = Array.isArray(found) ? idOf(found[0]) : undefined;
    if (existing !== undefined) return { id: existing, slug: wanted.slug };

    const me = await api.call('identity.whoami', {});
    const ownerId = typeof me === 'object' && me !== null && 'userId' in me && typeof me.userId === 'string' ? me.userId : undefined;
    if (ownerId === undefined) throw new Error('identity.whoami did not say who is running the checks');

    const made = idOf(await api.call('identity.organization.create', { slug: wanted.slug, name: wanted.name ?? wanted.slug, ownerId }));
    if (made === undefined) throw new Error(`identity.organization.create did not return the "${wanted.slug}" organization`);

    return { id: made, slug: wanted.slug };
}
