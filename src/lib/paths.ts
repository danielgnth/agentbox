import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./env.ts";

// Every path is derived from HOME at call time, so tests can point HOME at a
// temporary directory.
export const home = () => env("HOME") ?? homedir();

export const configDir = () => join(env("XDG_CONFIG_HOME") ?? join(home(), ".config"), "agentbox");
export const configFile = () => join(configDir(), "config.toml");

export const claudeDir = () => join(home(), ".claude");
export const settingsFile = () => join(claudeDir(), "settings.json");
export const claudeMdFile = () => join(claudeDir(), "CLAUDE.md");

/** Token cache. Under ~/.claude, which Claude's sandbox keeps read-only. */
export const tokenDir = () => join(claudeDir(), "agent-gh");
export const ghConfigDir = () => join(tokenDir(), "gh");
/** What the hook did when it could not mint (readable from the sandbox, writable only by the hook). */
export const hookLogFile = () => join(tokenDir(), "hook.log");

/** Installed copy. Hooks run it unsandboxed, so it must live outside every writable path. */
export const installDir = () => join(home(), ".local", "share", "agentbox");
export const installedBinary = () => join(installDir(), "agentbox");
/** The PreToolUse hook: a dash prefilter in front of the binary (src/hook.sh). */
export const hookScript = () => join(installDir(), "hook");
export const shimPath = () => join(home(), ".local", "bin", "agentbox");
/** The settings template as last applied by `agentbox setup` (to remove entries it no longer manages). */
export const appliedFile = () => join(installDir(), "settings-applied.json");

/** Hook files from the prototype that `agentbox github hook` replaces. */
export const legacyHookFiles = () => [
  join(claudeDir(), "hooks", "agent-gh-hook"),
  join(claudeDir(), "hooks", "git-credential-agent"),
];

/** A path as a Claude Code permission rule path: `~/…` under HOME, `//…` otherwise. */
export function rulePath(path: string): string {
  const h = home();
  if (path.startsWith(`${h}/`)) {
    return `~/${path.slice(h.length + 1)}`;
  }
  return `/${path}`;
}
