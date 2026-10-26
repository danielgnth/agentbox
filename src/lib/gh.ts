// Read-only lookups through YOUR gh login, used to suggest config values.
// Every helper returns undefined (or []) when gh is missing, signed out or
// lacks access, so the setup wizard can fall back to plain prompts.
import { run, which } from "./proc.ts";

interface InstallationList {
  installations: Installation[];
}

async function ghJson<T>(path: string): Promise<T | undefined> {
  const gh = which("gh");
  if (!gh) {
    return undefined;
  }
  const r = await run([gh, "api", path]);
  if (r.code !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return undefined;
  }
}

export interface GhUser {
  login: string;
  id: number;
  name: string | null;
}

export interface Installation {
  id: number;
  app_slug: string;
  account: { login: string };
  permissions: Record<string, string>;
}

export interface AppInfo {
  slug: string;
  name: string;
  client_id: string;
  owner: { login: string };
}

export const ghUser = () => ghJson<GhUser>("user");

/** Organizations you belong to. */
export async function ghOrgs(): Promise<string[]> {
  const orgs = await ghJson<{ login: string }[]>("user/orgs?per_page=100");
  return (orgs ?? []).map((o) => o.login);
}

/**
 * App installations on `owner` that you can see. /user/installations needs a
 * token GitHub accepts for it; for organizations, the org listing is a fallback.
 */
export async function ghInstallations(owner: string, isOrg: boolean): Promise<Installation[]> {
  let list = await ghJson<InstallationList>("user/installations?per_page=100");
  if (!list && isOrg) {
    list = await ghJson<InstallationList>(`orgs/${owner}/installations?per_page=100`);
  }
  return (list?.installations ?? []).filter((i) => i.account.login.toLowerCase() === owner.toLowerCase());
}

export const ghApp = (slug: string) => ghJson<AppInfo>(`apps/${encodeURIComponent(slug)}`);

export const botEmail = (id: number, login: string) => `${id}+${login}@users.noreply.github.com`;

/** The bot user GitHub creates for an App: git identity "<slug>[bot]". */
export async function ghBotIdentity(slug: string): Promise<{ name: string; email: string } | undefined> {
  const login = `${slug}[bot]`;
  const user = await ghJson<{ id: number }>(`users/${encodeURIComponent(login)}`);
  if (!user) {
    return undefined;
  }
  return { name: login, email: botEmail(user.id, login) };
}

/** "Name <id+login@users.noreply.github.com>", the address GitHub credits commits to. */
export const coauthorFor = (u: GhUser) => `${u.name || u.login} <${u.id}+${u.login}@users.noreply.github.com>`;

/** Installations whose App can push and open PRs, and that you or `owner` own (not third-party apps). */
export function fittingApps(installations: Installation[], apps: Map<string, AppInfo>, owners: string[]) {
  const ok = new Set(owners.map((o) => o.toLowerCase()));
  return installations.flatMap((installation) => {
    const app = apps.get(installation.app_slug);
    const canPush = installation.permissions.contents === "write" && installation.permissions.pull_requests === "write";
    if (app && canPush && ok.has(app.owner.login.toLowerCase())) {
      return [{ installation, app }];
    }
    return [];
  });
}
