import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ghConfigDir, hookLogFile, tokenDir } from "./paths.ts";

const MINUTE_MS = 60_000;
/** Installation tokens live 60 minutes; re-mint after 45. */
const MAX_AGE_MINUTES = 45;
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** Keep the hook log small: past this size, only the newest half is kept. */
const LOG_LIMIT_BYTES = 65_536;

/** Writes a file with mode 600 via rename, so readers never see half a token. */
function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: PRIVATE_FILE });
  renameSync(tmp, path);
}

export const MAX_AGE_MS = MAX_AGE_MINUTES * MINUTE_MS;

export const tokenFile = (repo: string) => join(tokenDir(), `${repo}.token`);

export function ensureTokenDir(): void {
  mkdirSync(ghConfigDir(), { recursive: true, mode: PRIVATE_DIR });
  chmodSync(tokenDir(), PRIVATE_DIR);
}

export function readToken(repo: string): string | undefined {
  try {
    return readFileSync(tokenFile(repo), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The cached token if it is younger than MAX_AGE_MS. */
export function freshToken(repo: string, now = Date.now()): string | undefined {
  const file = tokenFile(repo);
  if (!existsSync(file) || now - statSync(file).mtimeMs >= MAX_AGE_MS) {
    return undefined;
  }
  return readToken(repo);
}

export function writeToken(repo: string, token: string): void {
  ensureTokenDir();
  writePrivate(tokenFile(repo), token);
}

/**
 * Points gh (GH_CONFIG_DIR) at this token. config.yml is removed every time,
 * so aliases or extensions written there never survive into the next call.
 */
export function writeGhHosts(token: string, user: string): void {
  ensureTokenDir();
  rmSync(join(ghConfigDir(), "config.yml"), { force: true });
  writePrivate(
    join(ghConfigDir(), "hosts.yml"),
    `github.com:\n    oauth_token: ${token}\n    user: ${user}\n    git_protocol: https\n`,
  );
}

/** Appends a timestamped line to the hook log. */
export function appendHookLog(message: string): void {
  ensureTokenDir();
  const file = hookLogFile();
  if (existsSync(file) && statSync(file).size > LOG_LIMIT_BYTES) {
    const text = readFileSync(file, "utf8");
    writePrivate(file, text.slice(text.indexOf("\n", text.length / 2) + 1));
  }
  appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: PRIVATE_FILE });
}
