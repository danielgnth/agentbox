// End-to-end runs of the CLI against a temporary HOME. No 1Password, no
// GitHub, no Keychain (setup runs with --no-keychain).
import { beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cli, envWithHome, fakeRepo, OWNER, ROOT, useTempHome, write, writeConfig } from "./helpers.ts";

const HOOK_LINE = /^\+\s+"command": "\\"\$HOME\/\.local\/share\/agentbox\/hook\\""$/mu;
const BUILD_ID = /^[0-9a-f]{16}$/u;
/** install compiles a binary; give it time. */
const INSTALL_TIMEOUT_MS = 60_000;
const RERUNS = 2;
const NO_ACCESS = 0o000;
const INVALID_CONFIG = ["[github]", 'owner = "bad owner!"', "typo = 1", ""].join("\n");

let home: string;
const settings = () => join(home, ".claude", "settings.json");
const backups = () => readdirSync(join(home, ".claude")).filter((f) => f.startsWith("settings.json.bak-"));
const setup = (...extra: string[]) => cli(home, ["setup", "--no-keychain", ...extra]);

function seedPrototype(): void {
  writeConfig(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  copyFileSync(join(import.meta.dir, "fixtures", "settings.prototype.json"), settings());
  write(join(home, ".claude", "hooks", "agent-gh-hook"), "#!/bin/sh\n");
}

/** `git credential fill` for a URL, with agentbox as the only helper. */
function credentialFill(url: string): string {
  const helper = `!bun ${JSON.stringify(join(ROOT, "src", "main.ts"))} github credential`;
  const env = {
    ...envWithHome(home),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: helper,
    GIT_CONFIG_KEY_2: "credential.https://github.com.useHttpPath",
    GIT_CONFIG_VALUE_2: "true",
  };
  return Bun.spawnSync(["git", "credential", "fill"], { env, stdin: new Blob([`url=${url}\n\n`]) }).stdout.toString();
}

beforeEach(() => {
  home = useTempHome();
});

describe("config", () => {
  it("missing config names the path", () => {
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(home, ".config", "agentbox", "config.toml"));
    expect(r.stderr).toContain("Run agentbox setup in a terminal");
  });

  it("invalid config lists the problems", () => {
    writeConfig(home, INVALID_CONFIG);
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("github.owner is invalid");
    expect(r.stderr).toContain("unknown key github.typo");
    expect(r.stderr).toContain("github.app_client_id is required");
    expect(r.stderr).toContain("onepassword.vault is required");
  });

  it("a config.ts next to config.toml is never loaded", () => {
    writeConfig(home);
    write(join(home, ".config", "agentbox", "config.ts"), 'throw new Error("executed config.ts")');
    const r = setup("--dry-run");
    expect(r.code).toBe(0);
    expect(r.stderr + r.stdout).not.toContain("executed config.ts");
  });
});

describe("setup: first run", () => {
  beforeEach(seedPrototype);

  it("--dry-run writes nothing", () => {
    const before = readFileSync(settings(), "utf8");
    const r = setup("--dry-run");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(HOOK_LINE);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
    expect(existsSync(join(home, ".claude", "agent-gh"))).toBe(false);
  });

  it("applies the managed state and keeps the user's keys", () => {
    const first = setup();
    expect(first.code).toBe(0);
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    expect(s.model).toBe("opus[1m]");
    expect(s.env.GH_CONFIG_DIR).toBe(join(home, ".claude", "agent-gh", "gh"));
    expect(s.attribution.commit).toBe("Co-Authored-By: Octo Dev <123+octo-dev@users.noreply.github.com>");
    expect(JSON.stringify(s.hooks)).not.toContain(".claude/hooks/agent-gh-hook");
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("agent/<short-topic>");
    expect(existsSync(join(home, ".local", "share", "agentbox", "settings-applied.json"))).toBe(true);
    // Not interactive: the prototype file is reported, not deleted.
    expect(existsSync(join(home, ".claude", "hooks", "agent-gh-hook"))).toBe(true);
    expect(first.stdout + first.stderr).toContain("agent-gh-hook");
  });
});

describe("setup: reruns", () => {
  beforeEach(seedPrototype);

  it("every rerun is a no-op", () => {
    setup();
    const snapshot = readFileSync(settings(), "utf8");
    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    const runs = Array.from({ length: RERUNS }, () => setup());
    for (const again of runs) {
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("is up to date");
    }
    expect(readFileSync(settings(), "utf8")).toBe(snapshot);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(claudeMd);
    expect(backups()).toHaveLength(1);
  });

  it("keeps changes the user makes between runs", () => {
    setup();
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    s.sandbox.network.allowedDomains.push("added.later.example");
    s.effortLevel = "high";
    writeFileSync(settings(), JSON.stringify(s));
    expect(setup().code).toBe(0);
    const after = JSON.parse(readFileSync(settings(), "utf8"));
    expect(after.sandbox.network.allowedDomains).toContain("added.later.example");
    expect(after.effortLevel).toBe("high");
  });
});

describe("setup: edge cases", () => {
  it("works without an existing settings.json", () => {
    writeConfig(home);
    expect(setup().code).toBe(0);
    expect(JSON.parse(readFileSync(settings(), "utf8")).sandbox.enabled).toBe(true);
    expect(backups()).toEqual([]);
  });

  it("refuses to touch invalid JSON", () => {
    writeConfig(home);
    write(settings(), "{ not json");
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(settings(), "utf8")).toBe("{ not json");
  });
});

describe("git credential helper", () => {
  it("git credential fill gets the cached token only for the owner's repos", () => {
    writeConfig(home);
    write(join(home, ".claude", "agent-gh", "alpha.token"), "ghs_cached");
    expect(credentialFill(`https://github.com/${OWNER}/alpha.git`)).toContain("password=ghs_cached");
    expect(credentialFill("https://github.com/someone-else/alpha.git")).not.toContain("ghs_cached");
  });
});

describe("hook via the CLI", () => {
  it("non-GitHub commands exit 0 silently, even without a config", () => {
    const r = cli(home, ["github", "hook"], JSON.stringify({ cwd: home, tool_input: { command: "ls" } }));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("a GitHub command with a broken setup still exits 0", () => {
    const repo = fakeRepo(join(home, "alpha"), `https://github.com/${OWNER}/alpha.git`);
    const r = cli(home, ["github", "hook"], JSON.stringify({ cwd: repo, tool_input: { command: "git push" } }));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("agentbox:");
  });
});

describe("install", () => {
  it(
    "installs a copy and a shim that is not a link into the repo; reruns cleanly",
    () => {
      const first = cli(home, ["install"]);
      expect(first.code).toBe(0);
      expect(first.stdout + first.stderr).toContain("is not on your PATH");
      const binary = join(home, ".local", "share", "agentbox", "agentbox");
      const shim = join(home, ".local", "bin", "agentbox");
      expect(lstatSync(binary).isFile()).toBe(true);
      expect(readlinkSync(shim)).toBe(binary);
      expect(Bun.spawnSync([shim, "version"]).stdout.toString().trim()).toMatch(BUILD_ID);

      expect(cli(home, ["install"]).code).toBe(0);
      expect(readlinkSync(shim)).toBe(binary);
      // No staged build files left behind, here or in the install dir.
      expect(readdirSync(join(home, ".local", "share", "agentbox"))).toEqual(["agentbox", "hook"]);
      expect(readdirSync(home).filter((f) => f.endsWith(".bun-build"))).toEqual([]);

      // A repo's bunfig.toml (preload) and an unreadable .env must not affect the binary.
      const repo = join(home, "repo");
      write(join(repo, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      write(join(repo, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(home, "pwned"))}, "")`);
      write(join(repo, ".env"), "SECRET=1\n");
      chmodSync(join(repo, ".env"), NO_ACCESS);
      const inRepo = Bun.spawnSync([shim, "version"], { cwd: repo, env: envWithHome(home) });
      expect(inRepo.exitCode).toBe(0);
      expect(existsSync(join(home, "pwned"))).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    "refuses to replace a foreign ~/.local/bin/agentbox without --force",
    () => {
      write(join(home, ".local", "bin", "agentbox"), "#!/bin/sh\necho someone else\n");
      const r = cli(home, ["install"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--force");
    },
    INSTALL_TIMEOUT_MS,
  );
});
