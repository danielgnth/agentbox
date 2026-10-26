// agentbox reads its configuration from $XDG_CONFIG_HOME/agentbox/config.toml
// (default ~/.config/agentbox/config.toml). Nothing personal lives in the repo.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import EXAMPLE from "../config.example.toml" with { type: "text" };
import { configDir, configFile } from "./lib/paths.ts";
import { fail } from "./lib/ui.ts";

/** Valid values; shared with the setup wizard's prompts. */
const PATTERNS = {
  login: /^[A-Za-z0-9-]{1,39}$/u,
  noSpaces: /^\S+$/u,
  line: /^[^\n]+$/u,
  botName: /^[^\n<>]+$/u,
  email: /^[^\s<>]+@[^\s<>]+$/u,
  coauthor: /^[^<>\n]+ <[^\s<>]+@[^\s<>]+>$/u,
  digits: /^\d+$/u,
};

const TABLES: Record<string, string[]> = {
  github: ["owner", "app_client_id", "installation_id", "bot_name", "bot_email", "coauthor"],
  onepassword: ["keychain_service", "vault", "app_key_document"],
};

const DEFAULT_KEYCHAIN_SERVICE = "agentbox-op";
const DEFAULT_KEY_DOCUMENT = "github-app-key";

type Section = Record<string, unknown>;

interface Field {
  section: Section;
  table: string;
  key: string;
  pattern: RegExp;
}

let cached: Promise<Config> | undefined;

/** Collects every problem in the config, so one run reports all of them. */
function checker(raw: Record<string, unknown>) {
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(key in TABLES)) {
      errors.push(`unknown table [${key}]`);
    }
  }
  const table = (name: string): Section => {
    const value = raw[name] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`[${name}] must be a table`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!TABLES[name]?.includes(key)) {
        errors.push(`unknown key ${name}.${key}`);
      }
    }
    return value as Section;
  };
  const text = ({ section, table: name, key, pattern }: Field): string | undefined => {
    const value = section[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || !pattern.test(value)) {
      errors.push(`${name}.${key} is invalid: ${JSON.stringify(value)}`);
      return undefined;
    }
    return value;
  };
  const required = (value: string | undefined, name: string): string => {
    if (value === undefined) {
      errors.push(`${name} is required`);
    }
    return value ?? "";
  };
  const positiveInt = (value: unknown, name: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer`);
      return undefined;
    }
    return value;
  };
  return { errors, table, text, required, positiveInt };
}

async function read(): Promise<Config> {
  const raw = await readRawConfig();
  if (!raw) {
    fail(`no config at ${configFile()}. Create it, for example:\n\n${EXAMPLE}\nor run: agentbox setup`);
  }
  return parseConfig(raw, configFile());
}

export interface Config {
  github: {
    /** Account whose repos the agent may get tokens for. */
    owner: string;
    appClientId: string;
    /** Skips the per-repo installation lookup when set. */
    installationId?: number;
    /** Derived from the App when unset. */
    botName?: string;
    botEmail?: string;
    /** "Name <id+login@users.noreply.github.com>". Derived from your gh login when unset. */
    coauthor?: string;
  };
  onePassword: {
    /** Keychain item holding the read-only 1Password service account token. */
    keychainService: string;
    vault: string;
    appKeyDocument: string;
  };
}

export type RawConfig = Record<string, unknown>;

export { PATTERNS };

export const ROOT = dirname(import.meta.dir);

export function loadConfig(): Promise<Config> {
  cached ??= read();
  return cached;
}

/** The parsed TOML without validation, or undefined if the file doesn't exist. */
export async function readRawConfig(): Promise<RawConfig | undefined> {
  if (!existsSync(configFile())) {
    return undefined;
  }
  const { loadConfig: c12 } = await import("c12");
  // Only config.toml: naming the file exactly keeps c12 from picking up a
  // config.ts, which it would execute.
  const { config } = await c12<RawConfig>({
    cwd: configDir(),
    configFile: "config.toml",
    rcFile: false,
    globalRc: false,
    dotenv: false,
    packageJson: false,
    envName: false,
  });
  return config ?? {};
}

/** Validates the TOML structure and maps snake_case keys. */
export function parseConfig(raw: RawConfig, file = "config.toml"): Config {
  const check = checker(raw);
  const gh = check.table("github");
  const op = check.table("onepassword");
  const field = (section: Section, table: string, key: string, pattern: RegExp) =>
    check.text({ section, table, key, pattern });

  const config: Config = {
    github: {
      owner: check.required(field(gh, "github", "owner", PATTERNS.login), "github.owner"),
      appClientId: check.required(field(gh, "github", "app_client_id", PATTERNS.noSpaces), "github.app_client_id"),
      installationId: check.positiveInt(gh.installation_id, "github.installation_id"),
      botName: field(gh, "github", "bot_name", PATTERNS.botName),
      botEmail: field(gh, "github", "bot_email", PATTERNS.email),
      coauthor: field(gh, "github", "coauthor", PATTERNS.coauthor),
    },
    onePassword: {
      keychainService: field(op, "onepassword", "keychain_service", PATTERNS.noSpaces) ?? DEFAULT_KEYCHAIN_SERVICE,
      vault: check.required(field(op, "onepassword", "vault", PATTERNS.line), "onepassword.vault"),
      appKeyDocument: field(op, "onepassword", "app_key_document", PATTERNS.line) ?? DEFAULT_KEY_DOCUMENT,
    },
  };
  if ((config.github.botName === undefined) !== (config.github.botEmail === undefined)) {
    check.errors.push("set github.bot_name and github.bot_email together (or neither)");
  }
  if (check.errors.length > 0) {
    fail(`${file}:\n  ${check.errors.join("\n  ")}`);
  }
  return config;
}

/** config.toml text for a config (the inverse of parseConfig). */
export function formatConfig(cfg: Config): string {
  // A JSON string is a valid TOML basic string.
  const q = (s: string) => JSON.stringify(s);
  const { github: gh, onePassword: op } = cfg;
  const lines = ["# Written by `agentbox setup`. Edit freely, then run agentbox setup again.", "", "[github]"];
  lines.push(`owner = ${q(gh.owner)}`, `app_client_id = ${q(gh.appClientId)}`);
  if (gh.installationId !== undefined) {
    lines.push(`installation_id = ${gh.installationId}`);
  }
  if (gh.botName !== undefined) {
    lines.push(`bot_name = ${q(gh.botName)}`);
  }
  if (gh.botEmail !== undefined) {
    lines.push(`bot_email = ${q(gh.botEmail)}`);
  }
  if (gh.coauthor !== undefined) {
    lines.push(`coauthor = ${q(gh.coauthor)}`);
  }
  lines.push("", "[onepassword]", `keychain_service = ${q(op.keychainService)}`, `vault = ${q(op.vault)}`);
  lines.push(`app_key_document = ${q(op.appKeyDocument)}`, "");
  return lines.join("\n");
}
