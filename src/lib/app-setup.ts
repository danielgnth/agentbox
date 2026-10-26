// The GitHub App part of the setup wizard: keep the current App, pick one of
// yours that is already installed, enter a client ID, or create a new App via
// the manifest flow (its private key goes straight into 1Password).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, log, select } from "@clack/prompts";
import type { RawConfig } from "../config.ts";
import { type AppInfo, fittingApps, type GhUser, ghApp, ghInstallations, type Installation } from "./gh.ts";
import { api, signAppJwt } from "./github.ts";
import { convertCode, createAppFromManifest, type NewApp } from "./manifest.ts";
import { userCreateDocument, userItemExists, userReplaceDocument } from "./op.ts";
import { home } from "./paths.ts";
import { ask, DIGITS, matches, NO_SPACES, NON_EMPTY_LINE, openBrowser, optional, previous } from "./prompts.ts";
import { answer, errorMessage, step } from "./ui.ts";

const APP_NAME_MAX = 34;
const MINUTE_MS = 60_000;
const INSTALL_TIMEOUT_MINUTES = 10;
const POLL_INTERVAL_MS = 3000;
const PRIVATE_FILE = 0o600;

interface AppContext {
  existing: RawConfig | undefined;
  user: GhUser | undefined;
  owner: string;
  isOrg: boolean | undefined;
  vault: string;
  appKeyDocument: string;
}

interface Candidate {
  installation: Installation;
  app: AppInfo;
}

function findCandidates(ctx: AppContext): Promise<Candidate[]> {
  const { user } = ctx;
  if (!user) {
    return Promise.resolve([]);
  }
  return step(
    `Looking for your GitHub Apps installed on ${ctx.owner}`,
    async () => {
      const installs = await ghInstallations(ctx.owner, ctx.isOrg ?? false);
      const apps = new Map<string, AppInfo>();
      for (const app of await Promise.all(installs.map((i) => ghApp(i.app_slug)))) {
        if (app) {
          apps.set(app.slug, app);
        }
      }
      return fittingApps(installs, apps, [ctx.owner, user.login]);
    },
    "Checked for existing Apps",
  );
}

function appOptions(ctx: AppContext, currentClientId: string | undefined, candidates: Candidate[]) {
  const options: { value: string; label: string; hint?: string }[] = [];
  if (currentClientId) {
    options.push({ value: "keep", label: "Keep the App from the current config", hint: currentClientId });
  }
  for (const c of candidates) {
    if (c.app.client_id !== currentClientId) {
      options.push({ value: `app:${c.app.slug}`, label: c.app.name, hint: `installed on ${ctx.owner}` });
    }
  }
  options.push({ value: "create", label: `Create a new GitHub App on ${ctx.owner}`, hint: "opens your browser" });
  options.push({ value: "manual", label: "I have an App: enter its client ID" });
  return options;
}

const toNumber = (value: string | undefined) => {
  if (value) {
    return Number(value);
  }
};

async function enterManually(ctx: AppContext): Promise<AppChoice> {
  const clientId = await ask(
    "App client ID (Iv…)",
    undefined,
    matches(NO_SPACES, "the client ID from the App's settings"),
  );
  const installation = await ask(
    "Installation ID (optional; empty: looked up per repo)",
    undefined,
    optional(matches(DIGITS, "digits only")),
  );
  log.info(`The App's private key must be in 1Password as '${ctx.appKeyDocument}' in '${ctx.vault}'.`);
  return { clientId, installationId: toNumber(installation), appKeyDocument: ctx.appKeyDocument };
}

async function writeKey(vault: string, title: string, pem: string, replace: boolean): Promise<void> {
  if (replace) {
    await userReplaceDocument(vault, title, pem);
  } else {
    await userCreateDocument(vault, title, pem);
  }
}

function saveKeyToFile(app: NewApp, vault: string, title: string): string {
  const file = join(home(), `${app.slug}.private-key.pem`);
  writeFileSync(file, app.pem, { mode: PRIVATE_FILE });
  log.warn(`Saved to ${file}. Add it to 1Password as '${title}' in '${vault}', then delete the file.`);
  return title;
}

/** Stores the new App's key in 1Password with YOUR login. GitHub shows the key only once. */
async function storeKey(app: NewApp, vault: string, title: string): Promise<string> {
  try {
    const exists = await userItemExists(vault, title);
    if (exists) {
      const message = `'${title}' already exists in ${vault}. Replace it with the new App's key?`;
      if (!answer(await confirm({ message, initialValue: false }))) {
        const other = await ask("Document name for the new key", `${app.slug}-key`, matches(NON_EMPTY_LINE, "a name"));
        return storeKey(app, vault, other);
      }
    }
    const stored = "Private key stored in 1Password";
    await step(
      `Storing the private key in 1Password (${vault} / ${title})`,
      () => writeKey(vault, title, app.pem, exists),
      stored,
    );
    return title;
  } catch (e) {
    log.error(errorMessage(e));
    const retry = answer(
      await confirm({ message: "Try storing it again? (No: save it to a file)", initialValue: true }),
    );
    if (retry) {
      return storeKey(app, vault, title);
    }
    return saveKeyToFile(app, vault, title);
  }
}

async function installationOn(app: NewApp, owner: string): Promise<number | undefined> {
  const jwt = signAppJwt(app.client_id, app.pem);
  const res = await api<{ id: number; account: { login: string } }[]>("/app/installations", { bearer: jwt });
  if (!Array.isArray(res.data)) {
    return undefined;
  }
  return res.data.find((i) => i.account.login.toLowerCase() === owner.toLowerCase())?.id;
}

/** Polls the new App's installations (JWT signed with the in-memory key) until one on `owner` appears. */
async function waitForInstallation(app: NewApp, owner: string, until: number): Promise<number | undefined> {
  if (Date.now() >= until) {
    return undefined;
  }
  const id = await installationOn(app, owner);
  if (id !== undefined) {
    return id;
  }
  await Bun.sleep(POLL_INTERVAL_MS);
  return waitForInstallation(app, owner, until);
}

async function createApp(ctx: AppContext): Promise<AppChoice> {
  const isOrg =
    ctx.isOrg ?? answer(await confirm({ message: `Is ${ctx.owner} an organization?`, initialValue: false }));
  const name = await ask(
    `Name for the new App (unique on GitHub, max ${APP_NAME_MAX} characters)`,
    `${ctx.owner}-agent`.slice(0, APP_NAME_MAX),
    matches(new RegExp(`^.{1,${APP_NAME_MAX}}$`, "u"), `1 to ${APP_NAME_MAX} characters`),
  );
  log.step("Confirm the App on GitHub: contents, pull requests and issues write, the rest read, no workflows.");
  const flow = { open: openBrowser, convert: convertCode };
  const app = await step(
    "Waiting for you to create the App",
    () => createAppFromManifest({ owner: ctx.owner, isOrg, name }, flow),
    "App created",
  );
  log.success(`Created ${app.html_url}`);

  const appKeyDocument = await storeKey(app, ctx.vault, ctx.appKeyDocument);

  const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
  log.step(`Install the App on ${ctx.owner} and pick the repos agents may use.`);
  openBrowser(installUrl);
  const until = Date.now() + INSTALL_TIMEOUT_MINUTES * MINUTE_MS;
  const installationId = await step(
    `Waiting for the installation on ${ctx.owner}`,
    () => waitForInstallation(app, ctx.owner, until),
    "Installation found",
  );
  if (!installationId) {
    log.warn(`No installation seen yet. Install it later: ${installUrl}`);
  }
  return { clientId: app.client_id, installationId, slug: app.slug, appKeyDocument };
}

export interface AppChoice {
  clientId: string;
  installationId?: number;
  slug?: string;
  appKeyDocument: string;
  /** The App from the current config was kept. */
  kept?: boolean;
}

export type { AppContext };

export async function chooseApp(ctx: AppContext): Promise<AppChoice> {
  const currentClientId = previous(ctx.existing, "github", "app_client_id");
  const candidates = await findCandidates(ctx);
  const options = appOptions(ctx, currentClientId, candidates);
  const picked = answer(
    await select({ message: "GitHub App the agent acts as", options, initialValue: options[0]?.value }),
  );

  if (picked === "keep" && currentClientId) {
    const installationId = toNumber(previous(ctx.existing, "github", "installation_id"));
    return { clientId: currentClientId, installationId, appKeyDocument: ctx.appKeyDocument, kept: true };
  }
  const candidate = candidates.find((c) => `app:${c.app.slug}` === picked);
  if (candidate) {
    const { app, installation } = candidate;
    return {
      clientId: app.client_id,
      installationId: installation.id,
      slug: app.slug,
      appKeyDocument: ctx.appKeyDocument,
    };
  }
  if (picked === "manual") {
    return enterManually(ctx);
  }
  return createApp(ctx);
}
