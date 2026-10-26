import { existsSync, readFileSync, rmSync } from "node:fs";
import process from "node:process";
import { confirm, intro, log, note, outro } from "@clack/prompts";
import { defineCommand } from "citty";
import { type Config, formatConfig, parseConfig, type RawConfig, readRawConfig } from "../config.ts";
import { backup, diff, managedSettings, RULES, readJson, writeAtomic } from "../lib/managed.ts";
import { hasKeychainToken, storeKeychainToken } from "../lib/op.ts";
import {
  appliedFile,
  claudeMdFile,
  configFile,
  home,
  installedBinary,
  legacyHookFiles,
  settingsFile,
} from "../lib/paths.ts";
import { capture, need, run, which } from "../lib/proc.ts";
import { ask, matches } from "../lib/prompts.ts";
import { deepEqual, type Json, legacySettings, planSettings, stringify, upsertBlock } from "../lib/settings.ts";
import { ensureTokenDir } from "../lib/tokens.ts";
import { answer, fail, interactive, step, UserError } from "../lib/ui.ts";
import { configWizard } from "../lib/wizard.ts";

const OP_REF = /^op:\/\/\S+$/u;

const NEXT_STEPS = [
  "Restart Claude sessions (and VS Code windows) to load the settings.",
  "Then check from a Claude prompt (not the ! prompt):",
  "  touch ~/sandbox-probe        -> Operation not permitted",
  "  cat ~/.ssh/config            -> fails",
  "  agentbox github push (in one of your repos, on a branch) -> verified bot commits",
  "  gh pr list                   -> works without an unsandboxed retry",
  "  a new commit                 -> bot author + your Co-Authored-By trailer",
  "The first token may show a Keychain dialog for 'security': choose Always Allow.",
].join("\n");

function backupNote(saved: string | undefined): string {
  if (saved) {
    return ` (backup: ${saved})`;
  }
  return "";
}

function readText(file: string): string {
  if (existsSync(file)) {
    return readFileSync(file, "utf8");
  }
  return "";
}

function stringifyOrEmpty(value: Json | undefined): string {
  if (value === undefined) {
    return "";
  }
  return stringify(value);
}

/** The parsed config, or the problem with it. */
function tryParse(raw: RawConfig, file: string): Config | string {
  try {
    return parseConfig(raw, file);
  } catch (e) {
    if (!(e instanceof UserError)) {
      throw e;
    }
    return e.message;
  }
}

async function runWizard(raw: RawConfig | undefined, file: string): Promise<Config> {
  const cfg = await configWizard(raw);
  const text = formatConfig(cfg);
  parseConfig(Bun.TOML.parse(text) as RawConfig, file);
  const saved = backup(file);
  writeAtomic(file, text);
  log.success(`Wrote ${file}${backupNote(saved)}`);
  return cfg;
}

/** The config, asking for it interactively when it is missing or incomplete. */
async function ensureConfig(dry: boolean, reconfigure: boolean): Promise<Config> {
  const file = configFile();
  const raw = await readRawConfig();
  let reason = `no config at ${file}`;
  if (raw) {
    reason = "Going through the config questions again";
    if (!reconfigure) {
      const parsed = tryParse(raw, file);
      if (typeof parsed !== "string") {
        log.success(`Config: ${file}`);
        return parsed;
      }
      reason = parsed;
    }
  }
  if (!interactive()) {
    fail(
      `${reason}\nRun agentbox setup in a terminal to answer the config questions, or start from config.example.toml.`,
    );
  }
  if (dry) {
    fail(`${reason}\nRun agentbox setup without --dry-run to answer the config questions.`);
  }
  log.info(`${reason}\nSuggestions come from gh, op and the current config.`);
  return runWizard(raw, file);
}

async function keychain(cfg: Config, dry: boolean): Promise<void> {
  const service = cfg.onePassword.keychainService;
  if (await hasKeychainToken(cfg)) {
    log.success(`Keychain item '${service}' exists`);
    return;
  }
  if (dry || !interactive()) {
    log.warn(`Keychain item '${service}' is missing. Run agentbox setup in a terminal to store it.`);
    return;
  }
  const op = need("op", "brew install 1password-cli");
  const ref = await ask(
    "op:// reference of the 1Password service account token",
    "op://",
    matches(OP_REF, "an op:// reference, e.g. op://Private/agents-service-account/credential"),
  );
  // Read with YOUR 1Password login (biometric prompt), store in the Keychain.
  await step("Storing the service account token in the Keychain", async () =>
    storeKeychainToken(cfg, await capture([op, "read", ref])),
  );
}

async function validate(file: string): Promise<void> {
  JSON.parse(readFileSync(file, "utf8"));
  const jq = which("jq");
  if (jq && (await run([jq, "empty", file])).code !== 0) {
    fail(`${file} failed jq validation; restore the backup`);
  }
}

async function updateSettings(template: Json, dry: boolean): Promise<void> {
  const file = settingsFile();
  const current = readJson(file);
  const lastApplied = readJson(appliedFile());
  const next = planSettings({ current: current ?? {}, template, lastApplied, legacy: legacySettings(home()) });

  if (current !== undefined && deepEqual(current, next)) {
    log.success(`${file} is up to date`);
  } else if (dry) {
    log.info(`${file} would change:`);
    process.stdout.write(await diff("settings.json", stringifyOrEmpty(current), stringify(next)));
  } else {
    const saved = backup(file);
    writeAtomic(file, stringify(next));
    await validate(file);
    log.success(`Updated ${file}${backupNote(saved)}`);
  }
  // Remember what was applied, so entries dropped from a future template get removed.
  if (!(dry || deepEqual(lastApplied, template))) {
    writeAtomic(appliedFile(), stringify(template));
  }
}

async function updateClaudeMd(dry: boolean): Promise<void> {
  const file = claudeMdFile();
  const before = readText(file);
  const after = upsertBlock(before, RULES);
  if (before === after) {
    log.success(`${file}: agent rules are up to date`);
  } else if (dry) {
    log.info(`${file} would change:`);
    process.stdout.write(await diff("CLAUDE.md", before, after));
  } else {
    const saved = backup(file);
    writeAtomic(file, after);
    log.success(`Updated the agent rules in ${file}${backupNote(saved)}`);
  }
}

async function removeLegacyFiles(dry: boolean): Promise<void> {
  const files = legacyHookFiles().filter((f) => existsSync(f));
  if (files.length === 0) {
    return;
  }
  const list = files.map((f) => `  ${f}`).join("\n");
  if (dry || !interactive()) {
    log.warn(`Old hook prototypes are no longer used and can be deleted:\n${list}`);
    return;
  }
  if (answer(await confirm({ message: `Delete the old hook prototypes?\n${list}`, initialValue: true }))) {
    for (const f of files) {
      rmSync(f);
    }
    log.success("Deleted the old hook prototypes");
  }
}

async function setup(dry: boolean, reconfigure: boolean, checkKeychain: boolean): Promise<void> {
  const cfg = await ensureConfig(dry, reconfigure);
  if (checkKeychain) {
    await keychain(cfg, dry);
  }
  if (!existsSync(installedBinary())) {
    log.warn("agentbox is not installed, so the hook has nothing to run. From the repo: bin/agentbox install");
  }
  const template = await step("Resolving bot identity and co-author", () => managedSettings(cfg), "Identity resolved");
  await updateSettings(template, dry);
  await updateClaudeMd(dry);
  if (!dry) {
    ensureTokenDir();
  }
  await removeLegacyFiles(dry);
}

export const command = defineCommand({
  meta: {
    name: "setup",
    description: "Bring ~/.claude/settings.json and CLAUDE.md to the managed state (safe to re-run)",
  },
  args: {
    "dry-run": { type: "boolean", description: "Show what would change, write nothing" },
    reconfigure: { type: "boolean", description: "Go through the config questions again (current values suggested)" },
    keychain: {
      type: "boolean",
      default: true,
      description: "Check the 1Password service account token in the Keychain",
      negativeDescription: "Skip the Keychain check",
    },
  },
  async run({ args }) {
    const dry = Boolean(args["dry-run"]);
    if (dry) {
      intro("agentbox setup (dry run, nothing is written)");
    } else {
      intro("agentbox setup");
    }
    await setup(dry, Boolean(args.reconfigure), args.keychain);
    if (dry) {
      outro("Dry run done. Run without --dry-run to apply.");
      return;
    }
    note(NEXT_STEPS, "Next");
    outro("Done. Safe to run again any time.");
  },
});
