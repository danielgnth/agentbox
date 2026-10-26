import process from "node:process";
import { defineCommand } from "citty";
import { loadConfig } from "../../config.ts";
import { mintToken, repoName } from "../../lib/github.ts";

// Prints ONLY the token. Errors go to stderr.
export const command = defineCommand({
  meta: { name: "token", description: "Print a one-hour token scoped to the given repos" },
  args: { repo: { type: "positional", required: true, description: "repo or owner/repo; more than one allowed" } },
  async run({ args }) {
    const cfg = await loadConfig();
    const repos = args._.map((r) => repoName(cfg, r));
    process.stdout.write(`${await mintToken(cfg, repos)}\n`);
  },
});
