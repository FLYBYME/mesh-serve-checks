/**
 * mesh-serve-checks run [--config checks.config.ts] [--tag after-deploy:x]... [--only name]
 * Exit code 0 only when every check run passed, its cleanup included.
 */
import { parseArgs } from 'node:util';
import { run, type CheckResult } from './runner.js';

export async function main(argv: readonly string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
            config: { type: 'string', default: 'checks.config.ts' },
            tag: { type: 'string', multiple: true },
            only: { type: 'string' },
        },
    });

    if (positionals[0] !== 'run') {
        console.error('usage: mesh-serve-checks run [--config checks.config.ts] [--tag <tag>]... [--only <name>]');
        return 2;
    }

    const out = await run(values.config, { ...(values.tag !== undefined ? { tags: values.tag } : {}), ...(values.only !== undefined ? { only: values.only } : {}), onResult: print });
    const failed = out.results.filter((r) => !r.ok).length;
    console.log(`\n${out.results.length - failed} passed, ${failed} failed (trace ${out.traceId})`);

    return out.results.length > 0 && failed === 0 ? 0 : 1;
}

function print(r: CheckResult): void {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  (${(r.ms / 1000).toFixed(1)} s, ${r.file})`);
    for (const note of r.notes) console.log(`       ${note}`);
    if (r.error !== undefined) console.log(`       ${r.error}`);
    for (const e of r.cleanupErrors) console.log(`       cleanup: ${e}`);
    if (!r.ok) for (const s of r.steps) console.log(`       ${s.call} ${s.status} ${s.ms} ms${s.node !== undefined ? ` @${s.node}` : ''}`);
}
