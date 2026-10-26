import process from "node:process";
import { defineCommand } from "citty";
import { loadConfig } from "../../config.ts";
import { mintToken } from "../../lib/github.ts";
import { handleHook } from "../../lib/hook.ts";
import { appendHookLog } from "../../lib/tokens.ts";

/** Hook output is invisible in Claude Code, so problems also go to ~/.claude/agent-gh/hook.log. */
function log(message: string): void {
  process.stderr.write(`agentbox: ${message}\n`);
  try {
    appendHookLog(message);
  } catch {
    // Logging must never break the hook.
  }
}

// Claude Code PreToolUse hook on Bash. Runs OUTSIDE the sandbox and never
// blocks the command: it always exits 0.
export const command = defineCommand({
  meta: { name: "hook", description: "Claude Code PreToolUse hook: cache a token before git/gh network commands" },
  async run() {
    await handleHook(
      await Bun.stdin.text(),
      async () => {
        const cfg = await loadConfig();
        return {
          owner: cfg.github.owner,
          ghUser: cfg.github.botName ?? "x-access-token",
          mint: (repo) => mintToken(cfg, [repo]),
        };
      },
      log,
    );
    process.exit(0);
  },
});
