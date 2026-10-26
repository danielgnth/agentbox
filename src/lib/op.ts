import type { Config } from "../config.ts";
import { env, environment } from "./env.ts";
import { capture, need, run, which } from "./proc.ts";
import { fail } from "./ui.ts";

// Always /usr/bin/security, never Bun.secrets: the Keychain "Always Allow"
// approval then belongs to `security` and survives reinstalls of agentbox.
const SECURITY = "/usr/bin/security";
const OP_HINT = "brew install 1password-cli";

// Hooks can run with a bare environment where USER is unset.
const account = () => env("USER") ?? Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString().trim();

// --- As YOU (your 1Password login, biometric prompt), for setup only. The
// service account is read-only, so storing the App key needs your login.

/** The environment without a service account token, so op uses your own login. */
function userEnv(): Record<string, string | undefined> {
  const { OP_SERVICE_ACCOUNT_TOKEN: _serviceAccount, ...rest } = environment();
  return rest;
}

export async function hasKeychainToken(cfg: Config): Promise<boolean> {
  const r = await run([SECURITY, "find-generic-password", "-a", account(), "-s", cfg.onePassword.keychainService]);
  return r.code === 0;
}

export async function storeKeychainToken(cfg: Config, token: string): Promise<void> {
  const service = cfg.onePassword.keychainService;
  await capture([SECURITY, "add-generic-password", "-U", "-a", account(), "-s", service, "-w", token]);
}

/** Environment for `op` as the read-only service account. The token comes from the Keychain. */
export async function opEnv(cfg: Config): Promise<Record<string, string | undefined>> {
  const service = cfg.onePassword.keychainService;
  const token = await run([SECURITY, "find-generic-password", "-a", account(), "-s", service, "-w"]);
  if (token.code !== 0) {
    fail(`no Keychain item '${service}' (run: agentbox setup)`);
  }
  return { ...environment(), OP_SERVICE_ACCOUNT_TOKEN: token.stdout.trim() };
}

/** Runs `op` as the service account and returns its stdout. */
export async function opAgents(cfg: Config, args: string[]): Promise<string> {
  const op = need("op", OP_HINT);
  return capture([op, ...args], { env: await opEnv(cfg) });
}

/** Vault names you can see, or undefined when op is missing or signed out. */
export async function userVaults(): Promise<string[] | undefined> {
  const op = which("op");
  if (!op) {
    return undefined;
  }
  const r = await run([op, "vault", "list", "--format", "json"], { env: userEnv() });
  if (r.code !== 0) {
    return undefined;
  }
  try {
    return (JSON.parse(r.stdout) as { name: string }[]).map((v) => v.name);
  } catch {
    return undefined;
  }
}

export async function userItemExists(vault: string, title: string): Promise<boolean> {
  const op = need("op", OP_HINT);
  const r = await run([op, "item", "get", title, "--vault", vault, "--format", "json"], { env: userEnv() });
  return r.code === 0;
}

/** Stores `content` as a new document via stdin (it never touches disk). */
export async function userCreateDocument(vault: string, title: string, content: string): Promise<void> {
  const op = need("op", OP_HINT);
  const args = ["document", "create", "-", "--title", title, "--vault", vault, "--file-name", `${title}.pem`];
  await capture([op, ...args], { stdin: content, env: userEnv() });
}

/** Replaces an existing document's content via stdin. */
export async function userReplaceDocument(vault: string, title: string, content: string): Promise<void> {
  const op = need("op", OP_HINT);
  const args = ["document", "edit", title, "-", "--vault", vault, "--file-name", `${title}.pem`];
  await capture([op, ...args], { stdin: content, env: userEnv() });
}
