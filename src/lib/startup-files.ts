// Files that run code in your next terminal or git command: shell startup
// files and git config. Bash can't write them from the sandbox, but the
// Edit/Write tools run outside it, so the managed settings deny Edit on them.
// Their locations move with ZDOTDIR, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL and
// git includes, which permission rules can't expand, so setup resolves them.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "./env.ts";
import { home, rulePath } from "./paths.ts";
import { run, which } from "./proc.ts";

const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
const HOME_FILES = [".bashrc", ".bash_profile", ".profile", ".gitconfig"];
// A POSIX regex for git, matching include.path and includeIf.<condition>.path.
const INCLUDE_KEY = "^include(if\\..*)?\\.path$";

const xdgConfigHome = () => env("XDG_CONFIG_HOME") ?? join(home(), ".config");

async function gitConfig(args: string[]): Promise<string> {
  const git = which("git");
  if (!git) {
    return "";
  }
  return (await run([git, "config", ...args], { cwd: home() })).stdout;
}

/** The files `file` includes, as absolute paths. */
async function includes(file: string): Promise<string[]> {
  // Output is `key\nvalue\0` per entry; --type=path expands ~.
  const out = await gitConfig(["--file", file, "--type=path", "-z", "--get-regexp", INCLUDE_KEY]);
  return out
    .split("\0")
    .filter((entry) => entry.includes("\n"))
    .map((entry) => entry.slice(entry.indexOf("\n") + 1))
    .filter(Boolean)
    .map((value) => resolve(dirname(file), value)); // relative to the including file
}

/** The global core.hooksPath, if it is absolute (a relative one is per repo). */
async function gitHooksPath(): Promise<string | undefined> {
  const path = (await gitConfig(["--global", "--includes", "--type=path", "--get", "core.hooksPath"])).trim();
  if (path && isAbsolute(path)) {
    return path;
  }
  return undefined;
}

/** A shell config directory: its startup files if it is HOME, all of it otherwise. */
function zshRules(dir: string): string[] {
  if (dir === home()) {
    return ZSH_FILES.map((f) => `Edit(${rulePath(join(dir, f))})`);
  }
  return [`Edit(${rulePath(dir)}/**)`];
}

/** zsh's ZDOTDIR after ~/.zshenv ran (where it is usually set), else HOME. */
export async function zdotdir(): Promise<string> {
  const zsh = which("zsh");
  if (!zsh) {
    return env("ZDOTDIR") ?? home();
  }
  // .zshenv may print; the value is the last line.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh expands it, not JS.
  const r = await run([zsh, "-c", 'print -r -- "${ZDOTDIR:-$HOME}"']);
  return r.stdout.trim().split("\n").at(-1) || home();
}

/** Global git config files and everything they include, conditional includes too. */
export async function gitConfigFiles(): Promise<string[]> {
  const seen = new Set<string>();
  let level = [join(home(), ".gitconfig"), join(xdgConfigHome(), "git", "config")];
  const global = env("GIT_CONFIG_GLOBAL");
  if (global) {
    level.push(resolve(global));
  }
  while (level.length > 0) {
    const fresh = level.filter((f) => !seen.has(f));
    for (const f of fresh) {
      seen.add(f);
    }
    // One level of includes at a time.
    // biome-ignore lint/performance/noAwaitInLoops: each level depends on the one before.
    level = (await Promise.all(fresh.map(includes))).flat();
  }
  return [...seen];
}

/** Edit deny rules for this machine's shell startup files and git config. */
export async function startupFileRules(): Promise<string[]> {
  const xdg = xdgConfigHome();
  const [zdot, gitFiles, hooksPath] = await Promise.all([zdotdir(), gitConfigFiles(), gitHooksPath()]);
  const rules = [
    ...zshRules(home()),
    ...zshRules(join(home(), ".config", "zsh")),
    ...zshRules(join(xdg, "zsh")),
    ...zshRules(zdot),
    ...HOME_FILES.map((f) => `Edit(${rulePath(join(home(), f))})`),
    `Edit(${rulePath(join(home(), ".config", "fish"))}/**)`,
    `Edit(${rulePath(join(xdg, "fish"))}/**)`,
    `Edit(${rulePath(join(home(), ".config", "git"))}/**)`,
    `Edit(${rulePath(join(xdg, "git"))}/**)`,
    ...gitFiles.map((f) => `Edit(${rulePath(f)})`),
  ];
  if (hooksPath) {
    rules.push(`Edit(${rulePath(hooksPath)}/**)`);
  }
  return [...new Set(rules)];
}
