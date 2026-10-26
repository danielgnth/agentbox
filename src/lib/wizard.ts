// Interactive config for `agentbox setup`: asks for every value, suggesting
// what it can derive from your gh and op logins and from the current config.
import { log } from "@clack/prompts";
import type { Config, RawConfig } from "../config.ts";
import { type AppChoice, chooseApp } from "./app-setup.ts";
import { coauthorFor, type GhUser, ghBotIdentity, ghOrgs, ghUser } from "./gh.ts";
import { userVaults } from "./op.ts";
import { ask, COAUTHOR, choose, LOGIN, matches, NO_SPACES, NON_EMPTY_LINE, optional, previous } from "./prompts.ts";
import { step } from "./ui.ts";

const DEFAULT_VAULT = "Agents";
const DEFAULT_KEYCHAIN_SERVICE = "agentbox-op";
const DEFAULT_KEY_DOCUMENT = "github-app-key";

async function lookUpUser(): Promise<GhUser | undefined> {
  const user = await step("Looking up your GitHub account (gh)", ghUser, "GitHub account looked up");
  if (user) {
    log.info(`Signed in to gh as ${user.login}`);
  } else {
    log.warn("gh is not signed in, so there are fewer suggestions (gh auth login)");
  }
  return user;
}

/** The account the agent works on: you or one of your organizations. */
async function askOwner(existing: RawConfig | undefined, user: GhUser | undefined) {
  const current = previous(existing, "github", "owner");
  let orgs: string[] = [];
  if (user) {
    orgs = await ghOrgs();
  }
  const owner = await choose({
    message: "GitHub account the agent works on (owner of the repos)",
    suggestions: [
      { value: current ?? "", hint: "current config" },
      { value: user?.login ?? "", hint: "your account" },
      ...orgs.map((o) => ({ value: o, hint: "organization" })),
    ],
    initial: current ?? user?.login,
    validate: matches(LOGIN, "a GitHub login"),
  });
  let isOrg: boolean | undefined;
  if (user) {
    isOrg = owner.toLowerCase() !== user.login.toLowerCase();
  }
  return { owner, isOrg };
}

/** Where the App key lives, and how the read-only service account is found. */
async function askOnePassword(existing: RawConfig | undefined): Promise<Config["onePassword"]> {
  const vaults = await step(
    "Listing your 1Password vaults (op)",
    async () => (await userVaults()) ?? [],
    "Vaults listed",
  );
  const current = previous(existing, "onepassword", "vault");
  let initial = current;
  if (!initial && vaults.includes(DEFAULT_VAULT)) {
    initial = DEFAULT_VAULT;
  }
  const vault = await choose({
    message: "1Password vault for the App key (the only vault the service account can read)",
    suggestions: [{ value: current ?? "", hint: "current config" }, ...vaults.map((v) => ({ value: v }))],
    initial,
    validate: matches(NON_EMPTY_LINE, "a vault name"),
  });
  const keychainService = await ask(
    "Keychain item for the service account token",
    previous(existing, "onepassword", "keychain_service") ?? DEFAULT_KEYCHAIN_SERVICE,
    matches(NO_SPACES, "no spaces"),
  );
  const appKeyDocument = await ask(
    "1Password document holding the App private key",
    previous(existing, "onepassword", "app_key_document") ?? DEFAULT_KEY_DOCUMENT,
    matches(NON_EMPTY_LINE, "a document name"),
  );
  return { keychainService, vault, appKeyDocument };
}

/** The bot identity: looked up for a new or picked App, carried over when the App was kept. */
function botFor(app: AppChoice, existing: RawConfig | undefined): Promise<{ name: string; email: string } | undefined> {
  if (app.slug) {
    return ghBotIdentity(app.slug);
  }
  const name = previous(existing, "github", "bot_name");
  const email = previous(existing, "github", "bot_email");
  if (app.kept && name && email) {
    return Promise.resolve({ name, email });
  }
  return Promise.resolve(undefined);
}

async function askCoauthor(existing: RawConfig | undefined, user: GhUser | undefined): Promise<string | undefined> {
  let suggestion = previous(existing, "github", "coauthor") ?? "";
  if (!suggestion && user) {
    suggestion = coauthorFor(user);
  }
  const coauthor = await ask(
    "Co-author added to agent commits (empty: derive from gh at setup)",
    suggestion,
    optional(matches(COAUTHOR, "format: Name <id+login@users.noreply.github.com>")),
  );
  return coauthor || undefined;
}

export async function configWizard(existing: RawConfig | undefined): Promise<Config> {
  const user = await lookUpUser();
  const { owner, isOrg } = await askOwner(existing, user);
  const onePassword = await askOnePassword(existing);
  const app = await chooseApp({
    existing,
    user,
    owner,
    isOrg,
    vault: onePassword.vault,
    appKeyDocument: onePassword.appKeyDocument,
  });
  const bot = await botFor(app, existing);
  const coauthor = await askCoauthor(existing, user);
  return {
    github: {
      owner,
      appClientId: app.clientId,
      installationId: app.installationId,
      botName: bot?.name,
      botEmail: bot?.email,
      coauthor,
    },
    onePassword: { ...onePassword, appKeyDocument: app.appKeyDocument },
  };
}
