import process from "node:process";
import { defineCommand } from "citty";
import { loadConfig } from "../../config.ts";
import { env } from "../../lib/env.ts";
import { repoRemote } from "../../lib/github.ts";
import { hookLogFile } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Git, signedPush } from "../../lib/push.ts";
import { originUrl, repoFromUrl } from "../../lib/resolve.ts";
import { readToken } from "../../lib/tokens.ts";
import { fail } from "../../lib/ui.ts";

const SHORT_SHA = 7;

const git: Git = async (args) => {
  const r = await run(["git", ...args]);
  if (r.code !== 0) {
    fail(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
};

// Runs INSIDE the sandbox, like the credential helper: it uses the token the
// hook cached for this command, and never mints one itself.
export const command = defineCommand({
  meta: { name: "push", description: "Push a branch so GitHub signs its commits as the bot" },
  args: { branch: { type: "positional", required: false, description: "branch to push (default: the current one)" } },
  async run({ args }) {
    const cfg = await loadConfig();
    const { owner } = cfg.github;
    const url = originUrl(process.cwd());
    const repo = url && repoFromUrl(url, owner);
    if (!repo) {
      fail(`origin is not an https://github.com/${owner}/<repo> remote`);
    }
    const token = readToken(repo);
    if (!token) {
      fail(
        `no token cached for ${owner}/${repo}. The Claude Code hook caches one before this command; see ${hookLogFile()}`,
      );
    }
    // The sandbox sets the bot identity in GIT_AUTHOR_EMAIL; the config wins when it names one.
    const botEmail = cfg.github.botEmail ?? env("GIT_AUTHOR_EMAIL");
    if (!botEmail) {
      fail("unknown bot email: set github.bot_email in the config");
    }

    const r = await signedPush(git, repoRemote(owner, repo, token), { branch: args.branch, botEmail });
    if (r.upToDate) {
      process.stdout.write(`${r.branch} is up to date\n`);
      return;
    }
    let signed = "no new commits";
    if (r.created > 0) {
      signed = `${r.created} commit(s) created by GitHub, ${r.verified} verified`;
    }
    process.stdout.write(`pushed ${r.branch} at ${r.head.slice(0, SHORT_SHA)}: ${signed}\n`);
    process.stdout.write(`https://github.com/${owner}/${repo}/tree/${r.branch}\n`);
  },
});
