import process from "node:process";
import { defineCommand } from "citty";
import { loadConfig } from "../../config.ts";
import { credentialResponse } from "../../lib/hook.ts";
import { errorMessage } from "../../lib/ui.ts";

// git credential helper. Runs INSIDE the sandbox and only reads the token the
// hook cached. Answers nothing for repos outside the configured owner.
export const command = defineCommand({
  meta: { name: "credential", description: "git credential helper (reads the cached token)" },
  args: { action: { type: "positional", required: false, description: "get (store and erase are ignored)" } },
  async run({ args }) {
    if (args.action !== "get") {
      return;
    }
    try {
      const cfg = await loadConfig();
      const { stdout, note } = credentialResponse(await Bun.stdin.text(), cfg.github.owner);
      process.stdout.write(stdout);
      if (note) {
        process.stderr.write(`${note}\n`);
      }
    } catch (e) {
      // No credentials: git falls through to its own error, after this hint.
      process.stderr.write(`agentbox: ${errorMessage(e)}\n`);
    }
    process.exit(0);
  },
});
