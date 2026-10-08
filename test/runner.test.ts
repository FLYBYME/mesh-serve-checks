import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        expect(received.every((r) => r.url === '/api/_describe' || r.auth === 'Bearer test-token')).toBe(true);
        // One trace for the whole run.
        const traces = new Set(received.filter((r) => r.url !== '/api/_describe').map((r) => r.traceparent?.split('-')[1]));
        expect(traces.size).toBe(1);
        expect(out.results[0]?.steps[0]).toMatchObject({ call: 'thing.create', status: 200, node: 'node-a' });
    });

    it('stops a check that runs out of time', async () => {
        const out = await run(path.join(dir, 'checks.config.ts'), { tags: ['slow'] });
        expect(out.results[0]?.error).toBe('did not finish within 200ms');
    });
});
