/**
 * mesh-serve-checks run [--config checks.config.ts] [--tag x]... [--only name]
 *                       [--repeat N] [--until HH:MM] [--report-dir dir]
 *
 * One run, or a loop of them (overnight: --repeat 50 --until 06:00): each run's report kept in
 * --report-dir, a line per run on the way. Exit code 0 only when every run passed in full.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run, type CheckResult, type RunResult } from './runner.js';

export async function main(argv: readonly string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
            config: { type: 'string', default: 'checks.config.ts' },
            tag: { type: 'string', multiple: true },
            only: { type: 'string' },
            repeat: { type: 'string', default: '1' },
            until: { type: 'string' },
            'report-dir': { type: 'string' },
        },
    });

    if (positionals[0] !== 'run') {
        console.error('usage: mesh-serve-checks run [--config f] [--tag t]... [--only name] [--repeat N] [--until HH:MM] [--report-dir dir]');
        return 2;
    }

    const repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1) {
        console.error(`--repeat takes a whole number, not "${values.repeat}"`);
        return 2;
    }
    const stopAt = values.until !== undefined ? nextTime(values.until) : undefined;
    if (values['report-dir'] !== undefined) await mkdir(values['report-dir'], { recursive: true });

    let failedRuns = 0;
    let runs = 0;
    for (let i = 1; i <= repeat; i++) {
        if (stopAt !== undefined && Date.now() >= stopAt.getTime()) {
            console.log(`\nstopping: past ${values.until}`);
            break;
        }
        if (repeat > 1) console.log(`\n=== run ${i} of ${repeat} (${new Date().toISOString()})`);

        const reportFile = values['report-dir'] !== undefined
            ? path.join(values['report-dir'], `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
            : undefined;
        const out = await run(values.config, {
            ...(values.tag !== undefined ? { tags: values.tag } : {}),
            ...(values.only !== undefined ? { only: values.only } : {}),
            ...(reportFile !== undefined ? { reportFile } : {}),
            onResult: print,
        });
        runs++;
        if (!passed(out)) failedRuns++;
        summary(out);
    }

    if (runs > 1) console.log(`\n${runs - failedRuns} of ${runs} runs passed in full`);
    return runs > 0 && failedRuns === 0 ? 0 : 1;
}

function passed(out: RunResult): boolean {
    return out.results.length > 0 && out.results.every((r) => r.ok) && out.cleanupErrors.length === 0;
}

function summary(out: RunResult): void {
    const ok = out.results.filter((r) => r.ok).length;
    const blocked = out.results.filter((r) => r.blockedBy !== undefined).length;
    const failed = out.results.length - ok - blocked;
    for (const e of out.cleanupErrors) console.log(`CLEANUP ${e}`);
    console.log(`${ok} passed, ${failed} failed, ${blocked} blocked${out.cleanupErrors.length > 0 ? `, ${out.cleanupErrors.length} cleanup error(s)` : ''} (trace ${out.traceId})`);
}

function print(r: CheckResult): void {
    if (r.blockedBy !== undefined) {
        console.log(`--   ${r.name}  (blocked by: ${r.blockedBy})`);
        return;
    }
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  (${(r.ms / 1000).toFixed(1)} s, ${r.file})`);
    for (const note of r.notes) console.log(`       ${note}`);
    if (r.error !== undefined) console.log(`       ${r.error}`);
    for (const e of r.cleanupErrors) console.log(`       cleanup: ${e}`);
    if (!r.ok) for (const s of r.steps) console.log(`       ${s.call} ${s.status} ${s.ms} ms${s.node !== undefined ? ` @${s.node}` : ''}`);
}

/** The next time the clock reads HH:MM (local): today if still ahead, else tomorrow. */
function nextTime(hhmm: string): Date {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (match === null) throw new Error(`--until takes HH:MM, not "${hhmm}"`);

    const at = new Date();
    at.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);

    return at;
}
