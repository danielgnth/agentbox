// Which repo does a shell command talk to? Pure string and file parsing: the
// hook runs outside the sandbox, so it never starts git in the agent's repo.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { home } from "./paths.ts";

// Start of a command: line start or a shell separator.
const START = String.raw`(?:^|[;&|(\x60\s])`;
// One shell word: quoted, or unquoted with backslash escapes (iCloud's "Mobile\ Documents").
const WORD = String.raw`(?:"[^"]*"|'[^']*'|(?:\\.|[^\s;&|\\])+)`;
const ARG = `(?<arg>${WORD})`;
// Git's global options before the subcommand: -C <dir>, -c <key=value>, --no-pager, --git-dir=...
const GIT_OPTION = String.raw`(?:-[Cc]\s+${WORD}|--?[A-Za-z][\w-]*(?:=\S*)?)`;
const NAME = "(?<repo>[A-Za-z0-9._-]+)";
const GIT_NET = new RegExp(
  String.raw`${START}git(?:\s+${GIT_OPTION})*\s+(?:push|pull|fetch|clone|ls-remote|submodule)(?:\s|$)`,
  "u",
);
const GH = new RegExp(`${START}gh\\s`, "u");
// `agentbox github push` pushes with git and calls the API, so it needs a token too.
const AGENTBOX_PUSH = new RegExp(String.raw`${START}(?:\S*/)?agentbox\s+github\s+push(?:\s|$)`, "u");
const GIT_C_DIR = new RegExp(String.raw`${START}git(?:\s+${GIT_OPTION})*?\s+-C\s+${ARG}`, "u");
const LEADING_CD = new RegExp(String.raw`^\s*cd\s+${ARG}\s*(?:&&|;|\n)`, "u");
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const QUOTED = /^(?<quote>["'])(?<body>.*)\k<quote>$/u;
const ESCAPED = /\\(?<char>.)/gu;
const GIT_SUFFIX = /\.git$/u;
const ORIGIN_SECTION = /^\[remote\s+"origin"\]$/u;
const URL_LINE = /^url\s*=\s*(?<url>.+)$/u;
const GITDIR_LINE = /^gitdir:\s*(?<dir>.+)$/mu;

/** A shell word's value: quotes removed, or backslash escapes resolved. */
function unquote(word: string): string {
  if (QUOTED.test(word)) {
    return word.replace(QUOTED, "$<body>");
  }
  return word.replace(ESCAPED, "$<char>");
}

function expand(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(home(), path.slice(1));
  }
  return resolve(cwd, path);
}

/** The git dir a `.git` entry stands for: the directory itself, or a worktree's `gitdir:` target. */
function gitDirOf(dotGit: string): string | undefined {
  if (!statSync(dotGit).isFile()) {
    return dotGit;
  }
  const target = GITDIR_LINE.exec(readFileSync(dotGit, "utf8"))?.groups?.dir;
  if (!target) {
    return undefined;
  }
  return resolve(dirname(dotGit), target.trim());
}

/** The repo's git config file, following worktrees to the common dir. */
function gitConfigFile(start: string): string | undefined {
  let dir = start;
  while (!existsSync(join(dir, ".git"))) {
    if (dirname(dir) === dir) {
      return undefined;
    }
    dir = dirname(dir);
  }
  let gitDir = gitDirOf(join(dir, ".git"));
  if (!gitDir) {
    return undefined;
  }
  const common = join(gitDir, "commondir");
  if (existsSync(common)) {
    gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
  }
  const config = join(gitDir, "config");
  if (existsSync(config)) {
    return config;
  }
  return undefined;
}

/** The first repo named by `owner/<repo>` in one of the patterns. */
function pickRepo(cmd: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const name = pattern.exec(cmd)?.groups?.repo?.replace(GIT_SUFFIX, "");
    if (name && isRepoName(name)) {
      return name;
    }
  }
  return undefined;
}

/** Repos named explicitly in the command: -R/--repo, a github.com URL, gh repo/api arguments. */
function namedRepo(cmd: string, owner: string, gh: boolean): string | undefined {
  const url = new RegExp(String.raw`github\.com[:/]${owner}/${NAME}`, "iu");
  if (!gh) {
    return pickRepo(cmd, [url]);
  }
  return pickRepo(cmd, [
    new RegExp(String.raw`(?:^|\s)(?:-R|--repo)(?:\s+|=)["']?${owner}/${NAME}`, "iu"),
    url,
    new RegExp(String.raw`${START}gh\s+repo\s+\S+\s+["']?${owner}/${NAME}`, "iu"),
    new RegExp(String.raw`${START}gh\s+api\s+["']?/?repos/${owner}/${NAME}`, "iu"),
  ]);
}

/** The directory the command runs git in: `git -C <dir>`, a leading `cd <dir> &&`, or cwd. */
function commandDir(cmd: string, cwd: string): string {
  const dir = GIT_C_DIR.exec(cmd)?.groups?.arg ?? LEADING_CD.exec(cmd)?.groups?.arg;
  if (dir) {
    return expand(unquote(dir), cwd);
  }
  return cwd;
}

export interface Kind {
  git: boolean;
  gh: boolean;
}

/** Does the command do git network I/O or call gh? Cheap: runs on every Bash call. */
export const classify = (cmd: string): Kind => ({
  git: GIT_NET.test(cmd) || AGENTBOX_PUSH.test(cmd),
  gh: GH.test(cmd),
});

/** A plain repo name: safe as a file name and in API paths. */
export const isRepoName = (s: string) => REPO_NAME.test(s) && s !== "." && s !== "..";

/** The repo name in a github.com URL of `owner`, if any. */
export function repoFromUrl(url: string, owner: string): string | undefined {
  const pattern = new RegExp(String.raw`github\.com[:/]${owner}/(?<repo>[A-Za-z0-9._-]+?)(?:\.git)?/?$`, "iu");
  const name = pattern.exec(url.trim())?.groups?.repo;
  if (name && isRepoName(name)) {
    return name;
  }
  return undefined;
}

/** The origin URL from the repo's git config, read without running git (handles worktrees). */
export function originUrl(start: string): string | undefined {
  const config = gitConfigFile(start);
  if (!config) {
    return undefined;
  }
  let inOrigin = false;
  for (const line of readFileSync(config, "utf8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inOrigin = ORIGIN_SECTION.test(t);
    } else if (inOrigin) {
      const url = URL_LINE.exec(t)?.groups?.url;
      if (url) {
        return unquote(url.trim());
      }
    }
  }
  return undefined;
}

/**
 * Resolution order:
 *  1. gh -R/--repo owner/repo
 *  2. a github.com[:/]owner/repo URL in the command (clone, ls-remote)
 *  3. gh repo <sub> owner/repo, gh api repos/owner/repo/...
 *  4. the origin remote of `git -C <dir>`, a leading `cd <dir> &&`, or cwd
 */
export function resolveRepo(cmd: string, cwd: string, owner: string): string | undefined {
  const named = namedRepo(cmd, owner, classify(cmd).gh);
  if (named) {
    return named;
  }
  const url = originUrl(commandDir(cmd, cwd));
  if (url) {
    return repoFromUrl(url, owner);
  }
  return undefined;
}
