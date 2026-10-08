# mesh-serve-checks

Live checks for a [mesh-serve](https://github.com/FLYBYME/mesh-serve) api: small scenarios that do
what a person does, against the real thing, and clean up after themselves.

Unit tests prove code against stand-ins. A live check proves the platform: the gateway, its gates,
the real database, DNS, certificates, the order things happen in. It runs in an organization of its
own, never a customer's, and undoes what it made.

## A check

Checks live beside the code they check (a service's `checks/` folder), as its tests do.

```ts
// checks/provider-default.check.ts
import { check } from '@flybyme/mesh-serve-checks';

export default check('a provider marked default stays default', { tags: ['after-deploy:certs', 'hourly'] }, async (t) => {
    const made = await t.api.call('certProvider.create', { name: t.unique('check'), type: 'manual', default: true });
    const id = typeof made === 'object' && made !== null && 'id' in made ? String(made.id) : '';
    t.cleanup(() => t.api.call('certProvider.delete', { id }));

    t.expect(made, 'the provider as made').toMatchObject({ default: true });
});
```

What a check is given, `t`, and nothing more:

| | |
|---|---|
| `t.api.call(key, input)` | A call by its key, through the api's public gateway, as the check's identity. The check organization is given as `tenantId` wherever a call takes one. Every call of a run carries one W3C trace id. |
| `t.api.callParsed(key, input, parse)` | The same, its answer parsed into what the check relies on (a zod schema's `parse`). |
| `t.http.get(url)` | What a visitor gets, from outside: status, headers, body, redirect, and the certificate judged as a browser would. |
| `t.cleanup(step)` | An undo step. All of them run after the check, last first, pass or fail. A failing cleanup fails the check. |
| `t.until(what, probe, within)` | Waits until `probe` gives a value, or fails naming `what`. |
| `t.unique(prefix)`, `t.expect(value, what)`, `t.note(line)` | A run-unique name; an assertion; a line in the report. |
| `t.org` | The organization the check runs in. |

## The config

```ts
// checks.config.ts
import { defineConfig } from '@flybyme/mesh-serve-checks';

export default defineConfig({
    api: 'https://api.example.com',
    checks: ['../*/checks/*.check.ts'],
    organization: { slug: 'checks' },                  // made by the runner if it is not there
    identities: { operator: { session: true } },        // the mesh-serve CLI's signed-in session
    report: { file: 'checks-report.json' },
});
```

An identity is `{ session: true }` (the `mesh-serve login` session, checked to be for this api and
live) or `{ env: 'NAME' }` (a token from the environment). Credentials are named, never written.

## Running

```sh
npx mesh-serve-checks run --config checks.config.ts --tag after-deploy:certs
```

Exit code 0 only when every check that ran passed, its cleanup included. Run it after a deploy (and
fail the deploy on it), and on a timer.

## Roadmap

- `t.events`: wait on the api's events instead of polling, as a mesh node that only listens.
- `t.stored`: a read-only view of what was stored, to tell an api that lost a value from a store that
  never had it.
- `t.git`: changes pushed the way a developer's are.
