import { createSign } from "node:crypto";
import type { Config } from "../config.ts";
import { botEmail, coauthorFor, ghUser } from "./gh.ts";
import { opAgents } from "./op.ts";
import type { Remote } from "./push.ts";
import { isRepoName } from "./resolve.ts";
import { fail } from "./ui.ts";

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;
const MS_PER_SECOND = 1000;
/** Issued slightly in the past against clock skew; GitHub allows at most 10 minutes. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
const GIT_SUFFIX = /\.git$/u;

/** A branch name in an API path: segments encoded, slashes kept. */
const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

const jwts = new WeakMap<Config, Promise<string>>();

interface ApiInit {
  method?: string;
  /** An App JWT or an installation token. */
  bearer?: string;
  body?: object;
}

/** A 9-minute App JWT, signed in memory. */
function sign(clientId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / MS_PER_SECOND);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: clientId };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

/** App JWT for the configured App. The private key streams from 1Password and never touches disk. */
function appJwt(cfg: Config): Promise<string> {
  let jwt = jwts.get(cfg);
  if (!jwt) {
    jwt = (async () => {
      const { appKeyDocument, vault } = cfg.onePassword;
      const key = await opAgents(cfg, ["document", "get", appKeyDocument, "--vault", vault]);
      return sign(cfg.github.appClientId, key);
    })();
    jwts.set(cfg, jwt);
  }
  return jwt;
}

async function callApi<T>(path: string, init: ApiInit = {}) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (init.bearer) {
    headers.Authorization = `Bearer ${init.bearer}`;
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body && JSON.stringify(init.body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T & { message?: string } };
}

const appApi = async <T>(cfg: Config, path: string, method = "GET", body?: object) =>
  callApi<T>(path, { method, body, bearer: await appJwt(cfg) });

async function installationId(cfg: Config, repo: string): Promise<number> {
  if (cfg.github.installationId) {
    return cfg.github.installationId;
  }
  const res = await appApi<{ id: number }>(cfg, `/repos/${cfg.github.owner}/${repo}/installation`);
  if (res.status !== HTTP_OK) {
    fail(`the GitHub App is not installed on ${cfg.github.owner}/${repo}`);
  }
  return res.data.id;
}

// What the agent's token may do: push branches, open PRs, write issues, read
// the rest. No workflows, no administration. The App has the same set.
export const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  actions: "read",
  artifact_metadata: "read",
  attestations: "read",
  checks: "read",
  code_quality: "read",
  security_events: "read",
  merge_queues: "read",
  packages: "read",
  pages: "read",
};

export const signAppJwt = sign;
export const api = callApi;

/** "repo" or "<owner>/repo" (owner must be the configured one) -> "repo". */
export function repoName(cfg: Config, input: string): string {
  const parts = input.trim().replace(GIT_SUFFIX, "").split("/");
  if (parts.length === 1) {
    parts.unshift(cfg.github.owner);
  }
  const [owner, repo = "", ...rest] = parts;
  if (rest.length > 0 || owner?.toLowerCase() !== cfg.github.owner.toLowerCase() || !isRepoName(repo)) {
    fail(`not a ${cfg.github.owner} repo: ${input}`);
  }
  return repo;
}

/** The App itself (proves the key in 1Password works). */
export async function getApp(cfg: Config): Promise<{ slug: string; name: string }> {
  const res = await appApi<{ slug: string; name: string }>(cfg, "/app");
  if (res.status !== HTTP_OK) {
    fail(`GitHub App auth failed: ${res.data.message ?? res.status}`);
  }
  return res.data;
}

/** A one-hour installation token limited to the given repos. */
export async function mintToken(cfg: Config, repos: string[]): Promise<string> {
  const [firstRepo] = repos;
  if (firstRepo === undefined || !repos.every(isRepoName)) {
    fail(`invalid repo list: ${repos.join(" ")}`);
  }
  const id = await installationId(cfg, firstRepo);
  const res = await appApi<{ token?: string }>(cfg, `/app/installations/${id}/access_tokens`, "POST", {
    repositories: repos,
    permissions: PERMISSIONS,
  });
  if (res.status !== HTTP_CREATED || !res.data.token?.startsWith("ghs_")) {
    fail(`GitHub API error: ${res.data.message ?? res.status}`);
  }
  return res.data.token;
}

/** Bot git identity: from the config, or derived from the App's bot user. */
export async function botIdentity(cfg: Config): Promise<{ name: string; email: string }> {
  const { botName, botEmail: email } = cfg.github;
  if (botName && email) {
    return { name: botName, email };
  }
  const { slug } = await getApp(cfg);
  const login = `${slug}[bot]`;
  const user = await callApi<{ id: number }>(`/users/${encodeURIComponent(login)}`);
  if (user.status !== HTTP_OK) {
    fail(`could not look up ${login}; set github.bot_name and github.bot_email`);
  }
  return { name: login, email: botEmail(user.data.id, login) };
}

/** "Name <id+login@users.noreply.github.com>": from the config, or derived from your gh login. */
export async function resolveCoauthor(cfg: Config): Promise<string> {
  if (cfg.github.coauthor) {
    return cfg.github.coauthor;
  }
  const user = await ghUser();
  if (!user) {
    fail("could not derive the co-author from gh (gh auth login), or set github.coauthor in the config");
  }
  return coauthorFor(user);
}

/** One repo through an installation token: the GitHub side of `agentbox github push`. */
export function repoRemote(owner: string, repo: string, token: string): Remote {
  const call = <T>(path: string, method = "GET", body?: object) =>
    callApi<T>(`/repos/${owner}/${repo}${path}`, { method, body, bearer: token });
  const ensure = (res: { status: number; data: { message?: string } }, status: number, what: string) => {
    if (res.status !== status) {
      fail(`${what} failed: ${res.data.message ?? res.status}`);
    }
  };
  return {
    async defaultBranch() {
      const res = await call<{ default_branch: string }>("");
      ensure(res, HTTP_OK, `reading ${owner}/${repo}`);
      return res.data.default_branch;
    },
    async branchHead(branch) {
      const res = await call<{ object: { sha: string } }>(`/git/ref/heads/${refPath(branch)}`);
      if (res.status === HTTP_NOT_FOUND) {
        return;
      }
      ensure(res, HTTP_OK, `reading branch ${branch}`);
      return res.data.object.sha;
    },
    async createCommit(commit) {
      const res = await call<{ sha: string; verification?: { verified?: boolean } }>("/git/commits", "POST", commit);
      ensure(res, HTTP_CREATED, "creating a commit");
      return { sha: res.data.sha, verified: res.data.verification?.verified === true };
    },
    async setBranch(branch, sha, exists) {
      if (exists) {
        const res = await call(`/git/refs/heads/${refPath(branch)}`, "PATCH", { sha, force: false });
        ensure(res, HTTP_OK, `updating branch ${branch}`);
      } else {
        const res = await call("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha });
        ensure(res, HTTP_CREATED, `creating branch ${branch}`);
      }
    },
  };
}
