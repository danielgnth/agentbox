// `agentbox github hook` (PreToolUse, outside the sandbox) and
// `agentbox github credential` (git helper, inside the sandbox).
import { basename } from "node:path";
import process from "node:process";
import { hookLogFile } from "./paths.ts";
import { classify, isRepoName, resolveRepo } from "./resolve.ts";
import { freshToken, readToken, writeGhHosts, writeToken } from "./tokens.ts";
import { errorMessage } from "./ui.ts";

const TRAILING_SLASHES = /\/+$/u;
const GIT_SUFFIX = /\.git$/u;
/** owner/repo: exactly two path segments. */
const PATH_SEGMENTS = 2;

interface HookEvent {
  cwd?: unknown;
  tool_input?: { command?: unknown };
}

const stderrLog = (msg: string) => {
  process.stderr.write(`agentbox: ${msg}\n`);
};

/** `value` if it is a non-empty string, else `fallback`. */
function stringOr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) {
    return value;
  }
  return fallback;
}

function parseEvent(input: string): { cmd: string; cwd: string } {
  const { cwd, tool_input: toolInput } = JSON.parse(input) as HookEvent;
  return { cmd: stringOr(toolInput?.command, ""), cwd: stringOr(cwd, process.cwd()) };
}

/** The cached token, or a freshly minted one (undefined when minting failed). */
async function tokenFor(repo: string, deps: HookDeps, log: (msg: string) => void): Promise<string | undefined> {
  const cached = freshToken(repo);
  if (cached) {
    return cached;
  }
  try {
    const token = await deps.mint(repo);
    writeToken(repo, token);
    return token;
  } catch (e) {
    log(`could not mint a token for ${deps.owner}/${repo}: ${errorMessage(e)}`);
    return undefined;
  }
}

function credentialFields(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    if (!line.trim()) {
      break;
    }
    const i = line.indexOf("=");
    if (i > 0) {
      fields.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  return fields;
}

export interface HookDeps {
  owner: string;
  /** Shown as the gh user; cosmetic. */
  ghUser: string;
  mint: (repo: string) => Promise<string>;
}

/**
 * Makes sure a fresh token for the command's repo is cached (and handed to gh)
 * before the command runs. Never throws: a failed mint only means git or gh
 * fail to authenticate. `deps` loads lazily, so non-GitHub commands cost a
 * JSON parse and two regexes.
 */
export async function handleHook(
  input: string,
  deps: () => Promise<HookDeps>,
  log: (msg: string) => void = stderrLog,
): Promise<void> {
  try {
    const { cmd, cwd } = parseEvent(input);
    const kind = classify(cmd);
    if (!(kind.git || kind.gh)) {
      return;
    }
    const loaded = await deps();
    const repo = resolveRepo(cmd, cwd, loaded.owner);
    if (!repo) {
      log(`no ${loaded.owner} repo in the command or its directory (${cwd}); no token for: ${cmd}`);
      return;
    }
    const token = await tokenFor(repo, loaded, log);
    if (token && kind.gh) {
      writeGhHosts(token, loaded.ghUser);
    }
  } catch (e) {
    log(`hook error: ${errorMessage(e)}`);
  }
}

export interface CredentialAnswer {
  /** What git reads on stdout (empty: no credentials). */
  stdout: string;
  /** Why there is no token, for stderr (git shows it). */
  note?: string;
}

/** git credential helper protocol: only `get`, only https://github.com/<owner>/*. */
export function credentialResponse(input: string, owner: string): CredentialAnswer {
  const fields = credentialFields(input);
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") {
    return { stdout: "" };
  }
  const path = fields.get("path") ?? "";
  if (!path.toLowerCase().startsWith(`${owner.toLowerCase()}/`)) {
    return { stdout: "" };
  }
  const repo = basename(path.replace(TRAILING_SLASHES, "").replace(GIT_SUFFIX, ""));
  if (path.split("/").filter(Boolean).length !== PATH_SEGMENTS || !isRepoName(repo)) {
    return { stdout: "" };
  }
  const token = readToken(repo);
  if (!token) {
    const note = `agentbox: no token cached for ${owner}/${repo}. The Claude Code hook caches one before git pull/fetch and agentbox github push; see ${hookLogFile()}`;
    return { stdout: "", note };
  }
  return { stdout: `username=x-access-token\npassword=${token}\n` };
}
