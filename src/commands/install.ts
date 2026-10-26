import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { defineCommand } from "citty";
import { ROOT } from "../config.ts";
import HOOK from "../hook.sh" with { type: "text" };
import { sourceHash } from "../lib/build.ts";
import { env } from "../lib/env.ts";
import { home, hookScript, installDir, installedBinary, shimPath } from "../lib/paths.ts";
import { need, run } from "../lib/proc.ts";
import { fail, step } from "../lib/ui.ts";

// Hooks run unsandboxed, so what they execute must not be writable from a
// sandboxed session: a compiled copy outside the repo and outside allowWrite,
// never a link into this checkout.

const EXECUTABLE = 0o755;

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Compiles src/main.ts into `outfile`, from `cwd`. */
async function compile(outfile: string, cwd: string, build: string): Promise<void> {
  const bun = need("bun", "brew install oven-sh/bun/bun");
  const main = join(ROOT, "src", "main.ts");
  const define = `AGENTBOX_BUILD=${JSON.stringify(build)}`;
  // Never read .env or bunfig.toml from the working directory: the hook runs
  // unsandboxed in the agent's repo (a bunfig.toml preload would run outside
  // the sandbox), and an unreadable .env makes Bun exit before main runs.
  const noAutoload = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];
  const args = ["build", "--compile", ...noAutoload, main, "--outfile", outfile, "--define", define];
  const r = await run([bun, ...args], { cwd });
  if (r.code !== 0) {
    fail(`bun build failed:\n${(r.stderr || r.stdout).trim()}`);
  }
}

/** Builds the binary and writes the hook prefilter into the install dir. */
async function installFiles(build: string): Promise<void> {
  mkdirSync(installDir(), { recursive: true, mode: EXECUTABLE });
  // Build in a throwaway folder on the same volume: bun leaves a staging
  // file in its working directory, and the rename into place stays atomic.
  const stage = mkdtempSync(join(installDir(), ".build-"));
  try {
    const binary = join(stage, "agentbox");
    await step("Building", () => compile(binary, stage, build), `Built ${build}`);
    chmodSync(binary, EXECUTABLE);
    renameSync(binary, installedBinary());
    const hook = join(stage, "hook");
    writeFileSync(hook, HOOK, { mode: EXECUTABLE });
    renameSync(hook, hookScript());
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  log.success(`Installed ${installedBinary()} and ${hookScript()}`);
}

/** Fails unless an existing shim may be replaced; returns whether one exists. */
function checkReplaceable(shim: string, target: string, force: boolean): "ok" | "replace" | "missing" {
  const stat = lstatOrUndefined(shim);
  if (!stat) {
    return "missing";
  }
  if (!stat.isSymbolicLink()) {
    if (!force) {
      fail(`${shim} exists and is not agentbox's; rerun with --force to replace it`);
    }
    return "replace";
  }
  const dest = resolve(dirname(shim), readlinkSync(shim));
  if (dest === target) {
    return "ok";
  }
  // A link into this checkout would let sessions working on the repo rewrite the hook.
  if (!(force || dest.startsWith(`${ROOT}/`))) {
    fail(`${shim} points to ${dest}; rerun with --force to replace it`);
  }
  return "replace";
}

function linkShim(shim: string, target: string, force: boolean): void {
  const state = checkReplaceable(shim, target, force);
  if (state === "replace") {
    rmSync(shim);
  }
  if (state !== "ok") {
    mkdirSync(dirname(shim), { recursive: true });
    symlinkSync(target, shim);
  }
  log.success(`${shim} -> ${target}`);
}

/** Tells you how to put the shim's directory on PATH if it isn't (the hooks don't need it; you do). */
function pathHint(): void {
  const dir = dirname(shimPath());
  if ((env("PATH") ?? "").split(":").includes(dir)) {
    return;
  }
  let shown = dir;
  if (dir.startsWith(`${home()}/`)) {
    shown = `$HOME${dir.slice(home().length)}`;
  }
  log.warn(
    [
      `${dir} is not on your PATH. Add this to ~/.zprofile, then open a new terminal:`,
      "  typeset -U path",
      `  path=("${shown}" $path)`,
    ].join("\n"),
  );
}

export const command = defineCommand({
  meta: {
    name: "install",
    description: "Build agentbox and install a copy to ~/.local/share/agentbox (run from the repo)",
  },
  args: {
    force: { type: "boolean", description: "Replace an existing ~/.local/bin/agentbox that isn't agentbox's" },
  },
  async run({ args }) {
    if (!existsSync(join(ROOT, "src", "main.ts"))) {
      fail("run install from the repo: bin/agentbox install");
    }
    if (!existsSync("/bin/dash")) {
      fail("/bin/dash not found; the hook prefilter needs it");
    }
    intro("agentbox install");
    const build = sourceHash(ROOT);
    await installFiles(build);
    linkShim(shimPath(), installedBinary(), Boolean(args.force));

    const check = await run([shimPath(), "version"]);
    if (check.stdout.trim() !== build) {
      fail(`${shimPath()} does not run the new build (got: ${(check.stdout || check.stderr).trim()})`);
    }
    pathHint();
    outro("Next: agentbox setup");
  },
});
