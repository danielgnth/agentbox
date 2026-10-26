// `agentbox github push`: publishes the agent's commits so that GitHub signs
// them. Runs INSIDE the sandbox with the token the hook cached.
//
// GitHub only verifies bot signatures on commits the App creates through the
// API. So the local commits are pushed to a scratch ref (that uploads trees and
// blobs), recreated one by one with POST /git/commits (same tree, message and
// parents; GitHub signs them as the bot), and the branch is pointed at the
// result. The local branch then moves to the signed commits, which have the
// same trees, so the working tree and index stay as they are.
import { fail } from "./ui.ts";

const HEADER_END = "\n\n";

interface Plan {
  origin: string;
  branch: string;
  head: string;
  remoteHead: string | undefined;
  /** Commits GitHub doesn't have yet, parents first. */
  commits: string[];
}

const trimmed = async (git: Git, args: string[]) => (await git(args)).trim();
const lines = (text: string) => text.split("\n").filter(Boolean);
const tracking = (origin: string, name: string) => `+refs/heads/${name}:refs/remotes/${origin}/${name}`;

async function isAncestor(git: Git, ancestor: string, of: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, of]);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(git: Git): Promise<string> {
  try {
    return await trimmed(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return fail("HEAD is detached; name the branch to push");
  }
}

/** What to push, after fetching what GitHub has. Refuses the default branch and non-fast-forwards. */
async function plan(git: Git, remote: Remote, opts: PushOptions): Promise<Plan> {
  const origin = opts.remoteName ?? "origin";
  const branch = opts.branch ?? (await currentBranch(git));
  await git(["check-ref-format", "--branch", branch]);
  const head = await trimmed(git, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);

  const defaultBranch = await remote.defaultBranch();
  if (branch === defaultBranch) {
    fail(`${branch} is the default branch; push to an agent/<topic> branch and open a pull request`);
  }
  const remoteHead = await remote.branchHead(branch);
  const refspecs = [tracking(origin, defaultBranch)];
  if (remoteHead) {
    refspecs.push(tracking(origin, branch));
  }
  await git(["fetch", "--quiet", "--no-tags", origin, ...refspecs]);
  if (remoteHead && !(await isAncestor(git, remoteHead, head))) {
    fail(`${origin}/${branch} has commits that ${branch} doesn't; run git pull --rebase ${origin} ${branch} first`);
  }

  const range = [head, "--not", `--remotes=${origin}`];
  const commits = lines(await git(["rev-list", "--reverse", "--topo-order", ...range]));
  // Recreating a commit makes the bot its author, so only the bot's own commits qualify.
  const foreign = lines(await git(["log", "--format=%ae%x00%h %s (%ae)", ...range]))
    .map((line) => line.split("\0"))
    .filter(([email]) => email?.toLowerCase() !== opts.botEmail.toLowerCase())
    .map(([, label]) => label);
  if (foreign.length > 0) {
    fail(`only the bot's own commits can be pushed (${opts.botEmail}); these are not:\n  ${foreign.join("\n  ")}`);
  }
  return { origin, branch, head, remoteHead, commits };
}

/** Has GitHub recreate the commits, parents first. Returns old -> new hashes and the verified count. */
async function recreate(git: Git, remote: Remote, p: Plan): Promise<{ signed: Map<string, string>; verified: number }> {
  const scratch = `refs/agentbox/${p.branch}`;
  await git(["push", "--quiet", "--no-verify", p.origin, `+${p.head}:${scratch}`]);
  const signed = new Map<string, string>();
  let verified = 0;
  try {
    for (const sha of p.commits) {
      // biome-ignore lint/performance/noAwaitInLoops: each commit needs its recreated parents' hashes.
      const data = parseCommit(await git(["cat-file", "commit", sha]));
      const parents = data.parents.map((parent) => signed.get(parent) ?? parent);
      const created = await remote.createCommit({ ...data, parents });
      signed.set(sha, created.sha);
      verified += Number(created.verified);
    }
  } finally {
    await git(["push", "--quiet", "--no-verify", p.origin, `:${scratch}`]).catch(() => undefined);
  }
  return { signed, verified };
}

/** Runs git in the repo and returns its stdout as is; throws on failure. */
export type Git = (args: string[]) => Promise<string>;

export interface CommitData {
  tree: string;
  parents: string[];
  message: string;
}

/** The GitHub side of a push. */
export interface Remote {
  defaultBranch: () => Promise<string>;
  /** The branch's commit on GitHub, or undefined if the branch doesn't exist. */
  branchHead: (branch: string) => Promise<string | undefined>;
  /** Creates a commit as the App (GitHub signs it). */
  createCommit: (commit: CommitData) => Promise<{ sha: string; verified: boolean }>;
  /** Creates the branch, or fast-forwards it when `exists`. */
  setBranch: (branch: string, sha: string, exists: boolean) => Promise<void>;
}

export interface PushOptions {
  /** Defaults to the checked-out branch. */
  branch?: string;
  /** Only commits authored with this address are recreated (they become the bot's). */
  botEmail: string;
  remoteName?: string;
}

export interface PushResult {
  branch: string;
  /** Commits recreated and signed by GitHub. */
  created: number;
  /** Of those, how many GitHub reported as verified. */
  verified: number;
  head: string;
  upToDate: boolean;
}

/** tree, parents and message from a raw commit object (`git cat-file commit`). */
export function parseCommit(raw: string): CommitData {
  let split = raw.indexOf(HEADER_END);
  if (split === -1) {
    split = raw.length;
  }
  const message = raw.slice(split + HEADER_END.length);
  let tree = "";
  const parents: string[] = [];
  for (const line of raw.slice(0, split).split("\n")) {
    if (line.startsWith("tree ")) {
      tree = line.slice("tree ".length);
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice("parent ".length));
    }
  }
  if (!tree) {
    fail("commit object without a tree");
  }
  return { tree, parents, message };
}

/** Pushes a branch so that every new commit on it is created, and signed, by GitHub. */
export async function signedPush(git: Git, remote: Remote, opts: PushOptions): Promise<PushResult> {
  const p = await plan(git, remote, opts);
  const exists = p.remoteHead !== undefined;
  const result = { branch: p.branch, created: 0, verified: 0, head: p.head, upToDate: false };
  if (p.commits.length === 0) {
    if (p.remoteHead === p.head) {
      return { ...result, upToDate: true };
    }
    // Nothing to sign: the branch points at a commit GitHub already has.
    await remote.setBranch(p.branch, p.head, exists);
    return result;
  }

  const { signed, verified } = await recreate(git, remote, p);
  const head = signed.get(p.head) ?? p.head;
  await remote.setBranch(p.branch, head, exists);
  await git(["fetch", "--quiet", "--no-tags", p.origin, tracking(p.origin, p.branch)]);
  // Compare-and-swap: fails if the branch moved during the push.
  const reason = "agentbox github push: commits signed by GitHub";
  await git(["update-ref", "-m", reason, `refs/heads/${p.branch}`, head, p.head]);
  return { ...result, created: signed.size, verified, head };
}
