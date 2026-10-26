import { describe, expect, it } from "bun:test";
import { type Config, formatConfig, parseConfig } from "../src/config.ts";
import { type AppInfo, coauthorFor, fittingApps, type Installation } from "../src/lib/gh.ts";
import { PERMISSIONS } from "../src/lib/github.ts";
import { buildManifest, createAppFromManifest, creationUrl, type NewApp } from "../src/lib/manifest.ts";

const STATE_PARAM = /state=(?<state>[0-9a-f]+)/u;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const FLOW_TIMEOUT_MS = 5000;

const FULL: Config = {
  github: {
    owner: "octo-dev",
    appClientId: "Iv23liEXAMPLE",
    installationId: 42,
    botName: "octo-app[bot]",
    botEmail: "999+octo-app[bot]@users.noreply.github.com",
    coauthor: 'Jürgen "JJ" Dev <123+octo-dev@users.noreply.github.com>',
  },
  onePassword: { keychainService: "agentbox-op", vault: "Agents", appKeyDocument: "github-app-key" },
};

const MANIFEST_OPTS = { owner: "octo-dev", isOrg: false, name: "octo-dev-agent" };

const FAKE_APP: NewApp = {
  id: 1,
  slug: "octo-dev-agent",
  name: "octo-dev-agent",
  client_id: "Iv1",
  pem: "PEM",
  html_url: "https://github.com/apps/x",
  owner: { login: "octo-dev" },
};

const canBind = (() => {
  try {
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

const installation = (slug: string, permissions: Record<string, string>): Installation => ({
  id: slug.length,
  app_slug: slug,
  account: { login: "octo-dev" },
  permissions,
});

const appEntry = (slug: string, owner: string): [string, AppInfo] => [
  slug,
  { slug, name: slug, client_id: `Iv-${slug}`, owner: { login: owner } },
];

/** What the browser would see: the page, then a forged and a genuine callback. */
async function browse(url: string) {
  const html = await (await fetch(url)).text();
  const state = STATE_PARAM.exec(html)?.groups?.state;
  const forged = (await fetch(`${url}callback?code=c1&state=wrong`)).status;
  const genuine = (await fetch(`${url}callback?code=c1&state=${state}`)).status;
  return { html, forged, genuine };
}

describe("formatConfig", () => {
  it("round-trips through TOML and validation", () => {
    expect(parseConfig(Bun.TOML.parse(formatConfig(FULL)) as Record<string, unknown>)).toEqual(FULL);
  });

  it("omits optional values that are unset", () => {
    const minimal: Config = { ...FULL, github: { owner: "octo-dev", appClientId: "Iv23liEXAMPLE" } };
    const text = formatConfig(minimal);
    expect(text).not.toContain("installation_id");
    expect(text).not.toContain("bot_name");
    expect(parseConfig(Bun.TOML.parse(text) as Record<string, unknown>).github).toEqual(minimal.github);
  });
});

describe("suggestions", () => {
  it("coauthorFor falls back to the login", () => {
    expect(coauthorFor({ login: "octo", id: 7, name: null })).toBe("octo <7+octo@users.noreply.github.com>");
    expect(coauthorFor({ login: "octo", id: 7, name: "Octo Cat" })).toBe("Octo Cat <7+octo@users.noreply.github.com>");
  });

  it("fittingApps keeps your own apps that can push, drops third-party and read-only ones", () => {
    const write = { contents: "write", pull_requests: "write" };
    const result = fittingApps(
      [
        installation("mine", write),
        installation("vercel", write),
        installation("readonly", { contents: "read", pull_requests: "write" }),
        installation("unknown", write),
      ],
      new Map([appEntry("mine", "Octo-Dev"), appEntry("vercel", "vercel"), appEntry("readonly", "octo-dev")]),
      ["octo-dev"],
    );
    expect(result.map((r) => r.app.slug)).toEqual(["mine"]);
  });
});

describe("manifest", () => {
  it("asks for exactly the token permissions, no webhook, private", () => {
    const m = buildManifest(MANIFEST_OPTS, "http://127.0.0.1:1234/callback");
    expect(m.default_permissions).toEqual(PERMISSIONS);
    expect(m.default_permissions).not.toHaveProperty("workflows");
    expect(m.default_permissions).not.toHaveProperty("administration");
    expect(m.hook_attributes.active).toBe(false);
    expect(m.public).toBe(false);
    expect(m.redirect_url).toBe("http://127.0.0.1:1234/callback");
  });

  it("user and organization creation URLs", () => {
    expect(creationUrl(MANIFEST_OPTS, "s1")).toBe("https://github.com/settings/apps/new?state=s1");
    expect(creationUrl({ ...MANIFEST_OPTS, isOrg: true }, "s2")).toBe(
      "https://github.com/organizations/octo-dev/settings/apps/new?state=s2",
    );
  });
});

describe.skipIf(!canBind)("manifest flow (needs local port binding)", () => {
  it("serves the form, rejects a wrong state, exchanges the code", async () => {
    let converted = "";
    let seen: Awaited<ReturnType<typeof browse>> | undefined;
    const app = await createAppFromManifest(MANIFEST_OPTS, {
      timeoutMs: FLOW_TIMEOUT_MS,
      convert: (code) => {
        converted = code;
        return Promise.resolve(FAKE_APP);
      },
      open: async (url) => {
        seen = await browse(url);
      },
    });
    expect(seen?.html).toContain('action="https://github.com/settings/apps/new?state=');
    expect(seen?.html).toContain("&quot;default_permissions&quot;");
    expect(seen?.forged).toBe(HTTP_BAD_REQUEST);
    expect(seen?.genuine).toBe(HTTP_OK);
    expect(converted).toBe("c1");
    expect(app).toEqual(FAKE_APP);
  });
});
