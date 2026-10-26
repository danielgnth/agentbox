import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { environment, setEnv } from "../src/lib/env.ts";

function stdinFor(stdin: string | undefined): "ignore" | Blob {
  if (stdin === undefined) {
    return "ignore";
  }
  return new Blob([stdin]);
}

export const ROOT = dirname(import.meta.dir);
export const OWNER = "octo-dev";

export const CONFIG = `[github]
owner = "${OWNER}"
app_client_id = "Iv23liEXAMPLE"
bot_name = "octo-app[bot]"
bot_email = "999+octo-app[bot]@users.noreply.github.com"
coauthor = "Octo Dev <123+octo-dev@users.noreply.github.com>"

[onepassword]
keychain_service = "agentbox-test"
vault = "Agents"
`;

/** A fresh HOME for this process (in-process tests) and its path. */
export function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  setEnv("HOME", home);
  setEnv("XDG_CONFIG_HOME", undefined);
  return home;
}

export function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function writeConfig(home: string, content = CONFIG): void {
  write(join(home, ".config", "agentbox", "config.toml"), content);
}

/** A directory that looks like a git checkout with the given origin. */
export function fakeRepo(dir: string, origin: string): string {
  const config = ["[core]", "\tbare = false", `[remote "origin"]`, `\turl = ${origin}`, ""].join("\n");
  write(join(dir, ".git", "config"), config);
  return dir;
}

/** The environment for a child process with this HOME (and no XDG_CONFIG_HOME). */
export function envWithHome(home: string): Record<string, string | undefined> {
  const { XDG_CONFIG_HOME: _xdg, ...rest } = environment();
  return { ...rest, HOME: home };
}

/** Runs the CLI from source with the given HOME. */
export function cli(home: string, args: string[], stdin?: string) {
  const r = Bun.spawnSync(["bun", join(ROOT, "src", "main.ts"), ...args], {
    env: envWithHome(home),
    stdin: stdinFor(stdin),
    cwd: home,
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
