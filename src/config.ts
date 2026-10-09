/**
 * One file says what a run is against and as whom. Checks themselves live beside the code they
 * check (each service's `checks/`); the config only says where to find them.
 */

/** Who a check calls as. Credentials are named here, never written here. */
export type Identity =
    /** The mesh-serve CLI's signed-in session (`mesh-serve login`), checked to be for this api and live. */
    | { readonly session: true }
    /** A token from an environment variable. */
    | { readonly env: string };

export interface ChecksConfig {
    /**
     * The api's origin, e.g. https://api.example.com. None for checks that stand a platform up
     * before it has an api (they use `t.exec`); `t.api` then refuses every call.
     */
    readonly api?: string;
    /** Where the checks are: globs, relative to this file. */
    readonly checks: readonly string[];
    /** The organization checks run in, made by the runner if it is not there. Never a customer's. */
    readonly organization?: { readonly slug: string; readonly name?: string };
    readonly identities?: Readonly<Record<string, Identity>>;
    /** Where each run's results are written as JSON, relative to this file. */
    readonly report?: { readonly file?: string };
}

export function defineConfig(config: ChecksConfig): ChecksConfig {
    return config;
}

export function isChecksConfig(value: unknown): value is ChecksConfig {
    return typeof value === 'object' && value !== null
        && (!('api' in value) || typeof value.api === 'string')
        && 'checks' in value && Array.isArray(value.checks)
        && (!('identities' in value) || (typeof value.identities === 'object' && value.identities !== null));
}
