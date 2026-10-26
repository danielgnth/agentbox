import { basename } from "node:path";
import { env, environment } from "./env.ts";
import { fail } from "./ui.ts";

// Hooks run with the PATH of the Claude process, which is minimal when VS Code
// starts from the Dock, so also look in the usual Homebrew locations.
const SEARCH_PATH = [env("PATH"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

interface Options {
  stdin?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export const which = (bin: string) => Bun.which(bin, { PATH: SEARCH_PATH });

/** Absolute path of `bin`, or a failure with an install hint. */
export function need(bin: string, hint?: string): string {
  const path = which(bin);
  if (path) {
    return path;
  }
  if (hint) {
    return fail(`'${bin}' not found (${hint})`);
  }
  return fail(`'${bin}' not found`);
}

/** Runs a command and captures its output. */
export async function run(cmd: string[], opts: Options = {}): Promise<Result> {
  let stdin: "ignore" | Blob = "ignore";
  if (opts.stdin !== undefined) {
    stdin = new Blob([opts.stdin]);
  }
  const proc = Bun.spawn(cmd, {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ?? environment(),
    cwd: opts.cwd,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs a command, returns trimmed stdout, fails with its stderr. */
export async function capture(cmd: string[], opts: Options = {}): Promise<string> {
  const r = await run(cmd, opts);
  if (r.code !== 0) {
    fail(`${basename(cmd[0] ?? "")} ${cmd[1] ?? ""} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}
