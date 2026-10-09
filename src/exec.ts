/**
 * A command a check runs (ssh, a provider's CLI, an install script): its exit code and output, for
 * the checks that stand a platform up rather than call one.
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ExecOptions {
    readonly cwd?: string;
    /** Added to the runner's environment. Values here never appear in the report. */
    readonly env?: Readonly<Record<string, string>>;
    /** Written to the command's standard input, then closed. */
    readonly input?: string;
    readonly timeoutMs?: number;
    /** A non-zero exit is an answer, not a failure (default: it fails the check). */
    readonly allowFailure?: boolean;
}

export class ExecFailed extends Error {
    constructor(readonly command: string, readonly result: ExecResult) {
        super(`${command} exited ${result.code}: ${lastLine(result.stderr) ?? lastLine(result.stdout) ?? '(no output)'}`);
    }
}

export function exec(command: string, args: readonly string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    const shown = [command, ...args].join(' ');

    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

        const limit = options.timeoutMs ?? 300_000;
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`${shown}: no end in ${Math.round(limit / 1000)} s`));
        }, limit);

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const result = { code: code ?? -1, stdout, stderr };
            if (result.code !== 0 && options.allowFailure !== true) {
                reject(new ExecFailed(shown, result));
                return;
            }
            resolve(result);
        });

        if (options.input !== undefined) child.stdin.write(options.input);
        child.stdin.end();
    });
}

function lastLine(text: string): string | undefined {
    const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
    const last = lines[lines.length - 1];
    return last === undefined ? undefined : last.slice(0, 300);
}
