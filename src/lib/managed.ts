// The managed Claude Code config: template rendering and file helpers shared
// by `setup` and `doctor`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import AGENT_RULES from "../../claude/agent-rules.md" with { type: "text" };
import TEMPLATE from "../../claude/settings.managed.json" with { type: "json" };
import type { Config } from "../config.ts";
import { botIdentity, resolveCoauthor } from "./github.ts";
import { configDir, ghConfigDir, installDir, rulePath, shimPath, tokenDir } from "./paths.ts";
import { run } from "./proc.ts";
import { type Json, render } from "./settings.ts";
import { errorMessage, fail } from "./ui.ts";

const BACKUP_STAMP_NOISE = /[-:]|\..*$/gu;

/** The agent rules setup keeps in ~/.claude/CLAUDE.md. */
export const RULES: string = AGENT_RULES;

/** The settings template with this machine's values filled in. */
export async function managedSettings(cfg: Config): Promise<Json> {
  const [bot, coauthor] = await Promise.all([botIdentity(cfg), resolveCoauthor(cfg)]);
  return render(TEMPLATE as Json, {
    BOT_NAME: bot.name,
    BOT_EMAIL: bot.email,
    COAUTHOR: coauthor,
    // Settings env values are not shell-expanded, so this one is absolute.
    GH_CONFIG_DIR: ghConfigDir(),
    INSTALL_RULE: rulePath(installDir()),
    SHIM_RULE: rulePath(shimPath()),
    CONFIG_RULE: rulePath(configDir()),
    TOKEN_RULE: rulePath(tokenDir()),
  });
}

/** Parsed JSON, undefined if the file is missing, a failure if it is not valid JSON. */
export function readJson(path: string): Json | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (e) {
    fail(`${path} is not valid JSON (${errorMessage(e)}); fix it first`);
  }
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Copies `path` to `path.bak-<timestamp>` if it exists; returns the backup path. */
export function backup(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const stamp = new Date().toISOString().replace(BACKUP_STAMP_NOISE, "");
  let target = `${path}.bak-${stamp}`;
  for (let i = 1; existsSync(target); i += 1) {
    target = `${path}.bak-${stamp}-${i}`;
  }
  copyFileSync(path, target);
  return target;
}

/** Unified diff of two texts (via diff(1)). */
export async function diff(label: string, before: string, after: string): Promise<string> {
  const a = join(tmpdir(), `agentbox-${process.pid}-a`);
  const b = join(tmpdir(), `agentbox-${process.pid}-b`);
  writeFileSync(a, before);
  writeFileSync(b, after);
  const r = await run(["diff", "-u", "--label", `${label} (current)`, "--label", `${label} (new)`, a, b]);
  return r.stdout;
}
