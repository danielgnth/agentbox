// Creates the agent's GitHub App with GitHub's manifest flow:
//   1. a localhost page auto-submits the manifest to github.com,
//   2. you confirm the App there, GitHub redirects back with a one-time code,
//   3. the code is exchanged for the App's credentials, private key included.
// The private key is only ever held in memory; the caller stores it in 1Password.
import { randomBytes } from "node:crypto";
import { PERMISSIONS } from "./github.ts";

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const STATE_BYTES = 16;
const MINUTE_MS = 60_000;
const DEFAULT_TIMEOUT_MINUTES = 15;
const HTML_SPECIAL = /[&<>"']/gu;
const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const escapeHtml = (s: string) => s.replace(HTML_SPECIAL, (c) => HTML_ENTITIES[c] ?? c);

/** The page that posts the manifest to GitHub (a form POST is the only way to hand it over). */
function manifestPage(opts: ManifestOptions, state: string, redirectUrl: string): Response {
  const manifest = JSON.stringify(buildManifest(opts, redirectUrl));
  const html = `<!doctype html><meta charset="utf-8"><title>agentbox: create GitHub App</title>
<form id="f" method="post" action="${escapeHtml(creationUrl(opts, state))}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<p>Sending the App manifest to GitHub… <button type="submit">Continue</button></p>
</form><script>document.getElementById("f").submit()</script>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Rejects after `ms`; the returned `cancel` stops the timer. */
function deadline(ms: number): { expired: Promise<never>; cancel: () => void } {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error("timed out waiting for GitHub")), ms);
  return { expired: promise, cancel: () => clearTimeout(timer) };
}

export interface NewApp {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  pem: string;
  html_url: string;
  owner: { login: string };
}

export interface ManifestOptions {
  owner: string;
  /** Organization accounts use a different creation URL. */
  isOrg: boolean;
  name: string;
}

export interface FlowDeps {
  /** Opens a URL in the browser. */
  open: (url: string) => void | Promise<void>;
  /** Exchanges the one-time code for the App's credentials. */
  convert: (code: string) => Promise<NewApp>;
  timeoutMs?: number;
}

export function buildManifest(opts: ManifestOptions, redirectUrl: string) {
  return {
    name: opts.name,
    description: "Identity for coding agents (agentbox): one-hour tokens, one repo each.",
    url: `https://github.com/${opts.owner}`,
    hook_attributes: { url: `https://github.com/${opts.owner}`, active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

export function creationUrl(opts: ManifestOptions, state: string): string {
  if (opts.isOrg) {
    return `https://github.com/organizations/${opts.owner}/settings/apps/new?state=${state}`;
  }
  return `https://github.com/settings/apps/new?state=${state}`;
}

export async function convertCode(code: string): Promise<NewApp> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const data = (await res.json().catch(() => ({}))) as NewApp & { message?: string };
  if (res.status !== HTTP_CREATED || !data.pem) {
    throw new Error(`GitHub could not create the App: ${data.message ?? res.status}`);
  }
  return data;
}

/** Runs the flow and resolves with the new App. Rejects on timeout. */
export async function createAppFromManifest(opts: ManifestOptions, deps: FlowDeps): Promise<NewApp> {
  const state = randomBytes(STATE_BYTES).toString("hex");
  const code = Promise.withResolvers<string>();
  let base = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return manifestPage(opts, state, `${base}/callback`);
      }
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: HTTP_NOT_FOUND });
      }
      const received = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !received) {
        return new Response("State mismatch.", { status: HTTP_BAD_REQUEST });
      }
      code.resolve(received);
      return new Response("GitHub App created. You can close this tab and return to the terminal.");
    },
  });
  base = `http://127.0.0.1:${server.port}`;

  const timeout = deadline(deps.timeoutMs ?? DEFAULT_TIMEOUT_MINUTES * MINUTE_MS);
  try {
    await deps.open(`${base}/`);
    return await deps.convert(await Promise.race([code.promise, timeout.expired]));
  } finally {
    timeout.cancel();
    server.stop(true);
  }
}
