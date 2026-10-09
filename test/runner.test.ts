import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runner.js';

/**
 * The runner against a stand-in api on localhost: the same describe-then-call protocol a mesh-serve
 * gateway speaks, recording what it was sent.
 */
describe('a run', () => {
    let server: http.Server;
    let origin = '';
    let dir = '';
    const received: Array<{ method: string; url: string; auth: string | undefined; traceparent: string | undefined; body: string }> = [];
    const orgs: Array<{ id: string; slug: string }> = [];
    const removed: string[] = [];

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
            req.on('end', () => {
                received.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, traceparent: req.headers.traceparent?.toString(), body });
                const send = (status: number, value: unknown): void => {
                    res.writeHead(status, { 'content-type': 'application/json', 'x-mesh-node': 'node-a' });
                    res.end(JSON.stringify(value));
                };
                const url = new URL(req.url ?? '/', 'http://x');
                if (url.pathname === '/api/_describe') {
                    return send(200, { calls: [
                        { key: 'identity.organization.find', method: 'GET', path: '/organizations' },
                        { key: 'identity.whoami', method: 'GET', path: '/whoami' },
                        { key: 'identity.organization.create', method: 'POST', path: '/organizations' },
                        { key: 'thing.create', method: 'POST', path: '/things', input: { properties: { tenantId: {}, name: {} } } },
                        { key: 'thing.delete', method: 'DELETE', path: '/things/:id' },
                    ] });
                }
                if (url.pathname === '/api/organizations' && req.method === 'GET') return send(200, orgs.filter((o) => url.searchParams.get('query')?.includes(o.slug)));
                if (url.pathname === '/api/whoami') return send(200, { userId: 'op-1' });
                if (url.pathname === '/api/organizations') {
                    const made = { id: 'org-e2e', slug: 'e2e' };
                    orgs.push(made);
                    return send(200, made);
                }
                if (url.pathname === '/api/things') return send(200, { id: `thing-${received.length}`, ...JSON.parse(body) });
                if (url.pathname.startsWith('/api/things/')) {
                    removed.push(url.pathname.split('/').pop() ?? '');
                    return send(200, {});
                }
                send(404, { message: 'no such route' });
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const address = server.address();
        origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

        dir = await mkdtemp(path.join(os.tmpdir(), 'checks-'));
        const lib = path.resolve('src/index.ts');
        await writeFile(path.join(dir, 'checks.config.ts'), `
            import { defineConfig } from '${lib}';
            export default defineConfig({
                api: '${origin}', checks: ['checks/*.check.ts'],
                organization: { slug: 'e2e' },
                identities: { operator: { env: 'CHECKS_TEST_TOKEN' } },
                report: { file: 'report.json' },
            });`);
        const checks = path.join(dir, 'checks');
        await mkdir(checks);
        await writeFile(path.join(checks, 'a-passes.check.ts'), `
            import { check } from '${lib}';
            export default check('makes a thing and undoes it', { tags: ['hourly'] }, async (t) => {
                const thing = await t.api.call('thing.create', { name: t.unique('thing') });
                const id = typeof thing === 'object' && thing !== null && 'id' in thing ? String(thing.id) : '';
                t.cleanup(() => t.api.call('thing.delete', { id }));
                t.expect(thing, 'the thing').toMatchObject({ tenantId: t.org.id });
            });`);
        await writeFile(path.join(checks, 'b-fails.check.ts'), `
            import { check } from '${lib}';
            export default check('fails, and still cleans up last-first', { tags: ['hourly'] }, async (t) => {
                t.cleanup(() => t.api.call('thing.delete', { id: 'first' }));
                t.cleanup(() => t.api.call('thing.delete', { id: 'second' }));
                t.expect(1, 'one').toBe(2);
            });`);
        await writeFile(path.join(checks, 'c-slow.check.ts'), `
            import { check } from '${lib}';
            export default check('runs out of time', { tags: ['slow'], timeout: '200ms' }, async () => {
                await new Promise((r) => setTimeout(r, 2000));
            });`);
        process.env.CHECKS_TEST_TOKEN = 'test-token';
    });

    afterAll(async () => {
        server.close();
        await rm(dir, { recursive: true, force: true });
    });

    it('runs the tagged checks in the check organization, as the identity, and cleans up last-first', async () => {
        const out = await run(path.join(dir, 'checks.config.ts'), { tags: ['hourly'] });

        expect(out.results.map((r) => [r.name, r.ok])).toEqual([['makes a thing and undoes it', true], ['fails, and still cleans up last-first', false]]);
        expect(out.results[1]?.error).toBe('one: expected 2, got 1');
        expect(removed.slice(-2)).toEqual(['second', 'first']);

        // The organization was made once, owned by whoever runs the checks, and given where a call takes one.
        expect(orgs).toEqual([{ id: 'org-e2e', slug: 'e2e' }]);
        expect(received.find((r) => r.url === '/api/things')?.body).toContain('"tenantId":"org-e2e"');
        // On every call, reads and deletes too, whether or not the call's input lists it.
        expect(received.filter((r) => r.method === 'DELETE').every((r) => r.url.includes('tenantId=org-e2e'))).toBe(true);
        expect(received.every((r) => r.url === '/api/_describe' || r.auth === 'Bearer test-token')).toBe(true);
        // One trace for the whole run.
        const traces = new Set(received.filter((r) => r.url !== '/api/_describe').map((r) => r.traceparent?.split('-')[1]));
        expect(traces.size).toBe(1);
        expect(out.results[0]?.steps[0]).toMatchObject({ call: 'thing.create', status: 200, node: 'node-a' });
    });

    it('runs a chain in the order its checks need, blocks what stands on a failure, and undoes the run at its end', async () => {
        const chain = await mkdtemp(path.join(os.tmpdir(), 'chain-'));
        const lib = path.resolve('src/index.ts');
        const log = path.join(chain, 'log.txt');
        await writeFile(path.join(chain, 'checks.config.ts'), `
            import { defineConfig } from '${lib}';
            export default defineConfig({ checks: ['*.check.ts'] });`);
        // File order is the reverse of the chain's: the runner orders by needs.
        await writeFile(path.join(chain, 'a-top.check.ts'), `
            import { check } from '${lib}';
            export default check('on top', { needs: ['middle'] }, async () => {});`);
        await writeFile(path.join(chain, 'b-middle.check.ts'), `
            import { check } from '${lib}';
            export default check('middle', { needs: ['bottom'] }, async (t) => {
                const machine = t.need('machine', (v) => String(v));
                await t.exec('sh', ['-c', 'echo "middle saw $M" >> "$LOG"'], { env: { M: machine, LOG: '${log}' } });
                t.cleanupAtEnd(() => t.exec('sh', ['-c', 'echo "undo middle" >> "$LOG"'], { env: { LOG: '${log}' } }));
                const failed = await t.exec('sh', ['-c', 'exit 3'], { allowFailure: true });
                t.expect(failed.code, 'exit code').toBe(4);
            });`);
        await writeFile(path.join(chain, 'c-bottom.check.ts'), `
            import { check } from '${lib}';
            export default check('bottom', {}, async (t) => {
                t.provide('machine', 'vm-1');
                t.cleanupAtEnd(() => t.exec('sh', ['-c', 'echo "undo bottom" >> "$LOG"'], { env: { LOG: '${log}' } }));
            });`);

        const out = await run(path.join(chain, 'checks.config.ts'));

        expect(out.results.map((r) => [r.name, r.ok, r.blockedBy ?? ''])).toEqual([['bottom', true, ''], ['middle', false, ''], ['on top', false, 'middle']]);
        expect(out.results[1]?.error).toBe('exit code: expected 4, got 3');
        // Undone once, after every check, last first -- the failure in the middle did not stop it.
        expect(await readFile(log, 'utf8')).toBe('middle saw vm-1\nundo middle\nundo bottom\n');
        await rm(chain, { recursive: true, force: true });
    });

    it('stops a check that runs out of time', async () => {
        const out = await run(path.join(dir, 'checks.config.ts'), { tags: ['slow'] });
        expect(out.results[0]?.error).toBe('did not finish within 200ms');
    });
});
