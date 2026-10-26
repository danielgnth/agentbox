// signedPush against real git: a bare repo plays GitHub. Its createCommit runs
// `git commit-tree` there with another committer, so hashes change like they
// do when GitHub recreates (and signs) a commit.
import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type CommitData, type Git, parseCommit, type Remote, signedPush } from "../src/lib/push.ts";
import { envWithHome, useTempHome, write } from "./helpers.ts";

const BOT = { name: "octo-app[bot]", email: "999+octo-app[bot]@users.noreply.github.com" };
const HUMAN = { name: "Octo Dev", email: "123+octo-dev@users.noreply.github.com" };

let home: string;
let bare: string;
let work: string;
let created: CommitData[];

function gitEnv(who = BOT): Record<string, string | undefined> {
  return {
    ...envWithHome(home),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
  };
}

function sh(cwd: string, args: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  let stdin: "ignore" | Blob = "ignore";
  if (opts.stdin !== undefined) {
    stdin = new Blob([opts.stdin]);
  }
  const r = Bun.spawnSync(["git", ...args], { cwd, env: opts.env ?? gitEnv(), stdin });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

const git: Git = (args) => Promise.resolve(sh(work, args));
const out = (cwd: string, args: string[]) => sh(cwd, args).trim();

function commit(file: string, message: string, who = BOT): string {
  write(join(work, file), `${message}\n`);
  sh(work, ["add", file], { env: gitEnv(who) });
  sh(work, ["commit", "--quiet", "-m", message], { env: gitEnv(who) });
  return out(work, ["rev-parse", "HEAD"]);
}

/** GitHub, played by the bare repo. */
const fakeGitHub: Remote = {
  defaultBranch: () => Promise.resolve("main"),
  branchHead(branch) {
    try {
      return Promise.resolve(out(bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
    } catch {
      return Promise.resolve(undefined);
    }
  },
  createCommit(data) {
    created.push(data);
    const parents = data.parents.flatMap((p) => ["-p", p]);
    const env = { ...gitEnv(), GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" };
    const sha = sh(bare, ["commit-tree", data.tree, ...parents, "-F", "-"], { stdin: data.message, env }).trim();
    return Promise.resolve({ sha, verified: true });
  },
  setBranch(branch, sha, exists) {
    if (exists) {
      // Fast-forward only, like PATCH with force: false.
      sh(bare, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, sha]);
    }
    sh(bare, ["update-ref", `refs/heads/${branch}`, sha]);
    return Promise.resolve();
  },
};

const push = (branch?: string) => signedPush(git, fakeGitHub, { branch, botEmail: BOT.email });

beforeEach(() => {
  home = useTempHome();
  bare = join(home, "remote.git");
  work = join(home, "work");
  created = [];
  sh(home, ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  sh(home, ["clone", "--quiet", bare, work]);
  sh(work, ["checkout", "--quiet", "-b", "main"]);
  commit("README.md", "initial", HUMAN);
  sh(work, ["push", "--quiet", "origin", "main"]);
  sh(work, ["checkout", "--quiet", "-b", "agent/x"]);
});

describe("signedPush", () => {
  it("recreates new commits on GitHub and moves the local branch onto them", async () => {
    const first = commit(
      "a.txt",
      "feat: a\n\nbody line\n\nCo-Authored-By: Octo Dev <123+octo-dev@users.noreply.github.com>",
    );
    const second = commit("b.txt", "feat: b");

    const r = await push();

    expect(r).toMatchObject({ branch: "agent/x", created: 2, verified: 2, upToDate: false });
    expect(r.head).not.toBe(second);
    expect(out(bare, ["rev-parse", "refs/heads/agent/x"])).toBe(r.head);
    expect(out(work, ["rev-parse", "refs/heads/agent/x"])).toBe(r.head);
    expect(out(work, ["rev-parse", "refs/remotes/origin/agent/x"])).toBe(r.head);
    // Same trees and messages, new hashes, chained onto the recreated parent.
    expect(out(work, ["rev-parse", `${r.head}^{tree}`])).toBe(out(work, ["rev-parse", `${second}^{tree}`]));
    expect(out(work, ["rev-parse", `${r.head}~1^{tree}`])).toBe(out(work, ["rev-parse", `${first}^{tree}`]));
    expect(out(work, ["rev-parse", `${r.head}~1`])).not.toBe(first);
    expect(sh(work, ["log", "-1", "--format=%B", `${r.head}~1`])).toBe(sh(work, ["log", "-1", "--format=%B", first]));
    expect(created[0]?.parents).toEqual([out(work, ["rev-parse", "main"])]);
    // Nothing left behind: no scratch ref, clean working tree.
    expect(out(bare, ["for-each-ref", "refs/agentbox"])).toBe("");
    expect(out(work, ["status", "--porcelain"])).toBe("");
  });

  it("only recreates what GitHub doesn't have yet", async () => {
    commit("a.txt", "feat: a");
    const before = (await push()).head;
    commit("b.txt", "feat: b");

    const r = await push("agent/x");

    expect(r.created).toBe(1);
    expect(out(bare, ["rev-parse", "refs/heads/agent/x~1"])).toBe(before);
    expect(await push()).toMatchObject({ upToDate: true, created: 0 });
  });

  it("creates a branch that has no new commits without recreating anything", async () => {
    const r = await push();
    expect(r).toMatchObject({ created: 0, upToDate: false });
    expect(out(bare, ["rev-parse", "refs/heads/agent/x"])).toBe(out(work, ["rev-parse", "main"]));
  });
});

describe("signedPush refuses", () => {
  it("the default branch", async () => {
    sh(work, ["checkout", "--quiet", "main"]);
    commit("a.txt", "feat: a");
    await expect(push()).rejects.toThrow("main is the default branch");
  });

  it("commits the bot didn't author, and pushes nothing", async () => {
    commit("a.txt", "feat: a");
    commit("b.txt", "fix: by hand", HUMAN);
    await expect(push()).rejects.toThrow(`fix: by hand (${HUMAN.email})`);
    expect(created).toEqual([]);
    expect(out(bare, ["for-each-ref", "refs/heads/agent", "refs/agentbox"])).toBe("");
  });

  it("when the remote branch has commits the local one lacks", async () => {
    commit("a.txt", "feat: a");
    await push();
    sh(work, ["reset", "--quiet", "--hard", "main"]);
    commit("c.txt", "feat: c");
    await expect(push()).rejects.toThrow("git pull --rebase origin agent/x");
  });
});

describe("parseCommit", () => {
  it("reads tree and parents, skips other headers, keeps the message exactly", () => {
    const raw = [
      "tree 1111111111111111111111111111111111111111",
      "parent 2222222222222222222222222222222222222222",
      "parent 3333333333333333333333333333333333333333",
      "author A <a@x> 1 +0000",
      "committer A <a@x> 1 +0000",
      "gpgsig -----BEGIN SSH SIGNATURE-----",
      " parent 4444444444444444444444444444444444444444",
      " -----END SSH SIGNATURE-----",
      "",
      "subject",
      "",
      "body\n",
    ].join("\n");
    expect(parseCommit(raw)).toEqual({
      tree: "1111111111111111111111111111111111111111",
      parents: ["2222222222222222222222222222222222222222", "3333333333333333333333333333333333333333"],
      message: "subject\n\nbody\n",
    });
  });
});
