import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { intro, log, outro } from "@clack/prompts";
import { defineCommand } from "citty";
import { type Config, loadConfig, ROOT } from "../config.ts";
import HOOK from "../hook.sh" with { type: "text" };
import { sourceHash } from "../lib/build.ts";
import { getApp } from "../lib/github.ts";
import { managedSettings, readJson } from "../lib/managed.ts";
import { hasKeychainToken, opAgents } from "../lib/op.ts";
import {
  appliedFile,
  home,
  hookScript,
  installDir,
  installedBinary,
  legacyHookFiles,
  settingsFile,
  shimPath,
} from "../lib/paths.ts";
import { run, which } from "../lib/proc.ts";
import { originUrl, repoFromUrl } from "../lib/resolve.ts";
import { deepEqual, legacySettings, planSettings } from "../lib/settings.ts";
import { errorMessage, fail } from "../lib/ui.ts";

const GITHUB_HOST = /github\.com/iu;
const HTTPS_URL = /^https:\/\//u;

/** A check resolves with an optional detail, or throws with the reason it failed. */
type Check = [label: string, test: () => Promise<string | undefined>];

interface Outcome {
  label: string;
  ok: boolean;
  detail?: string;
}

async function runCheck([label, test]: Check): Promise<Outcome> {
  try {
    return { label, ok: true, detail: await test() };
  } catch (e) {
    return { label, ok: false, detail: errorMessage(e) };
  }
}

function report({ label, ok, detail }: Outcome): void {
  let line = label;
  if (detail) {
    line = `${label}: ${detail}`;
  }
  if (ok) {
    log.success(line);
  } else {
    log.error(line);
  }
}

function hostChecks(cfg: Config): Check[] {
  return [
    [
      "op installed",
      () => {
        if (!which("op")) {
          return Promise.reject(new Error("brew install 1password-cli"));
        }
        return Promise.resolve(undefined);
      },
    ],
    [
      "Keychain token present",
      async () => {
        if (!(await hasKeychainToken(cfg))) {
          throw new Error(`no item '${cfg.onePassword.keychainService}' (agentbox setup stores it)`);
        }
      },
    ],
    [
      "1Password service account sees one vault",
      async () => {
        const vaults = JSON.parse(await opAgents(cfg, ["vault", "list", "--format", "json"])) as unknown[];
        if (vaults.length !== 1) {
          throw new Error(`it sees ${vaults.length}; scope it to '${cfg.onePassword.vault}' only`);
        }
      },
    ],
    ["GitHub App key works", async () => (await getApp(cfg)).slug],
  ];
}

async function checkInstall(): Promise<string | undefined> {
  if (!existsSync(installedBinary())) {
    throw new Error("run bin/agentbox install from the repo");
  }
  const dest = resolve(dirname(shimPath()), readlinkSync(shimPath()));
  if (dest !== installedBinary()) {
    throw new Error(`${shimPath()} points to ${dest}`);
  }
  if (!existsSync(hookScript()) || readFileSync(hookScript(), "utf8") !== HOOK) {
    throw new Error(`${hookScript()} is missing or outdated; rerun bin/agentbox install`);
  }
  // Only meaningful when run from the repo: does the install match this checkout?
  if (existsSync(join(ROOT, "src", "main.ts"))) {
    const installed = (await run([installedBinary(), "version"])).stdout.trim();
    if (installed !== sourceHash(ROOT)) {
      throw new Error("built from other sources; rerun bin/agentbox install");
    }
  }
  return installDir();
}

async function checkSettings(cfg: Config): Promise<string | undefined> {
  const current = readJson(settingsFile()) ?? {};
  const template = await managedSettings(cfg);
  const next = planSettings({
    current,
    template,
    lastApplied: readJson(appliedFile()),
    legacy: legacySettings(home()),
  });
  if (!deepEqual(current, next)) {
    throw new Error("run agentbox setup --dry-run to see the difference");
  }
  return undefined;
}

function warnings(cfg: Config): void {
  const legacy = legacyHookFiles().filter((f) => existsSync(f));
  if (legacy.length > 0) {
    log.warn(`Old hook prototypes still exist (agentbox setup offers to delete them):\n  ${legacy.join("\n  ")}`);
  }
  const origin = originUrl(process.cwd());
  if (origin && GITHUB_HOST.test(origin) && repoFromUrl(origin, cfg.github.owner) && !HTTPS_URL.test(origin)) {
    log.warn(`origin is ${origin}: use an HTTPS remote, SSH remotes can't use the token`);
  }
}

export const command = defineCommand({
  meta: { name: "doctor", description: "Check config, 1Password, the GitHub App, the install and the Claude settings" },
  async run() {
    intro("agentbox doctor");
    const cfg = await loadConfig();
    log.success("Config valid");
    const checks: Check[] = [
      ...hostChecks(cfg),
      ["Installed", checkInstall],
      ["Claude settings match the managed state", () => checkSettings(cfg)],
    ];
    // Run in parallel, report in order.
    const outcomes = await Promise.all(checks.map(runCheck));
    for (const outcome of outcomes) {
      report(outcome);
    }
    warnings(cfg);
    const failed = outcomes.filter((o) => !o.ok).length;
    if (failed > 0) {
      fail(`${failed} check(s) failed`);
    }
    outro("All good.");
  },
});
