import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import TEMPLATE from "../claude/settings.managed.json" with { type: "json" };
import { type Json, legacySettings, planSettings, render, upsertBlock } from "../src/lib/settings.ts";

type Obj = Record<string, Json>;

const HOME = "/Users/octo";
const VARS = {
  BOT_NAME: "octo-app[bot]",
  BOT_EMAIL: "999+octo-app[bot]@users.noreply.github.com",
  COAUTHOR: "Octo Dev <123+octo-dev@users.noreply.github.com>",
  GH_CONFIG_DIR: `${HOME}/.claude/agent-gh/gh`,
  INSTALL_RULE: "~/.local/share/agentbox",
  SHIM_RULE: "~/.local/bin/agentbox",
  CONFIG_RULE: "~/.config/agentbox",
  TOKEN_RULE: "~/.claude/agent-gh",
};
const template = render(TEMPLATE as Json, VARS);
const prototype = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "settings.prototype.json"), "utf8")) as Obj;
const legacy = legacySettings(HOME);
const plan = (current: Json, lastApplied?: Json, tmpl = template) =>
  planSettings({ current: structuredClone(current), template: tmpl, lastApplied, legacy });

/** The value at a path of object keys, or undefined. */
function at(value: Json | undefined, ...path: string[]): Json | undefined {
  let node = value;
  for (const key of path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

const strings = (value: Json | undefined) => (value ?? []) as string[];

/** A copy of `root` with `change` applied to the parent of the last path key. */
function edited(root: Json, path: string[], change: (parent: Obj, key: string) => void): Json {
  const copy = structuredClone(root) as Obj;
  let parent = copy;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Obj;
  }
  change(parent, path.at(-1) as string);
  return copy;
}

const withoutItem = (root: Json, path: string[], item: string) =>
  edited(root, path, (parent, key) => {
    parent[key] = strings(parent[key]).filter((v) => v !== item);
  });

const withoutKey = (root: Json, path: string[]) =>
  edited(root, path, (parent, key) => {
    Reflect.deleteProperty(parent, key);
  });

describe("planSettings on the prototype settings", () => {
  const next = plan(prototype);

  it("keeps keys agentbox doesn't manage", () => {
    for (const key of ["$schema", "model", "theme", "enabledPlugins", "spinnerVerbs"]) {
      expect(at(next, key)).toEqual(prototype[key] as Json);
    }
    expect(at(next, "env", "DISABLE_TELEMETRY")).toBe("1");
    expect(at(next, "permissions", "allow")).toEqual(["Bash(make test)"]);
    expect(at(next, "hooks", "Stop")).toEqual(at(prototype, "hooks", "Stop") as Json);
  });

  it("replaces the prototype hook, keeps the user's own hook", () => {
    const groups = at(next, "hooks", "PreToolUse") as { hooks: { command: string }[] }[];
    const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toEqual(["my-own-bash-logger", '"$HOME/.local/share/agentbox/hook"']);
  });

  it("points git at the installed credential helper", () => {
    expect(at(next, "env", "GIT_CONFIG_VALUE_1")).toBe('!"$HOME/.local/bin/agentbox" github credential');
    expect(at(next, "env", "GH_CONFIG_DIR")).toBe(`${HOME}/.claude/agent-gh/gh`);
  });

  it("fixes the co-author trailer", () => {
    expect(at(next, "attribution", "commit")).toBe("Co-Authored-By: Octo Dev <123+octo-dev@users.noreply.github.com>");
  });

  it("unions arrays without duplicates", () => {
    const domains = strings(at(next, "sandbox", "network", "allowedDomains"));
    expect(domains).toContain("my.private.registry");
    expect(domains.filter((d) => d === "github.com")).toHaveLength(1);
    const files = at(next, "sandbox", "credentials", "files") as { path: string }[];
    expect(files.filter((f) => f.path === "~/.ssh")).toHaveLength(1);
    expect(files.map((f) => f.path)).toContain("~/.my-secrets");
    expect(strings(at(next, "permissions", "deny"))).toContain("Read(~/.my-secrets/**)");
    expect(strings(at(next, "permissions", "deny"))).toContain("Edit(~/.local/share/agentbox/**)");
  });

  it("is idempotent", () => {
    expect(plan(next, template)).toEqual(next);
    expect(plan(plan(next, template), template)).toEqual(next);
  });
});

describe("entries dropped from the template", () => {
  it("are removed; the user's additions stay", () => {
    const applied = plan(prototype);
    let smaller = withoutItem(template, ["sandbox", "network", "allowedDomains"], "pypi.org");
    smaller = withoutItem(smaller, ["permissions", "ask"], "Bash(rm -rf *)");
    smaller = withoutKey(smaller, ["sandbox", "enableWeakerNetworkIsolation"]);
    const next = plan(applied, template, smaller);
    expect(strings(at(next, "sandbox", "network", "allowedDomains"))).not.toContain("pypi.org");
    expect(strings(at(next, "sandbox", "network", "allowedDomains"))).toContain("my.private.registry");
    expect(strings(at(next, "permissions", "ask"))).not.toContain("Bash(rm -rf *)");
    expect(at(next, "sandbox", "enableWeakerNetworkIsolation")).toBeUndefined();
    expect(plan(next, smaller, smaller)).toEqual(next);
  });

  it("a whole hook dropped from the template goes, the user's hook in that group stays", () => {
    const next = plan(plan(prototype), template, withoutKey(template, ["hooks"]));
    expect(at(next, "hooks", "PreToolUse")).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "my-own-bash-logger" }] },
    ]);
  });
});

describe("plan details", () => {
  it("GIT_CONFIG_COUNT covers the user's extra keys", () => {
    const current = { env: { GIT_CONFIG_KEY_4: "core.editor", GIT_CONFIG_VALUE_4: "vim" } };
    expect(at(plan(current), "env", "GIT_CONFIG_COUNT")).toBe("5");
    expect(at(plan({}), "env", "GIT_CONFIG_COUNT")).toBe("4");
  });

  it("empty settings get the full template", () => {
    expect(plan({})).toEqual(template as Obj);
  });

  it("render rejects unknown placeholders", () => {
    expect(() => render({ a: "{{NOPE}}" }, {})).toThrow("NOPE");
  });
});

describe("CLAUDE.md block", () => {
  const body = "## Rules\n- one";

  it("inserts into an empty file", () => {
    expect(upsertBlock("", body)).toContain("## Rules");
  });

  it("appends after existing content and replaces in place", () => {
    const first = upsertBlock("# Mine\n\nkeep me\n", body);
    expect(first.startsWith("# Mine\n\nkeep me\n\n<!-- agentbox:begin")).toBe(true);
    const second = upsertBlock(`${first}\n## After\n`, "## Rules\n- two");
    expect(second).toContain("- two");
    expect(second).not.toContain("- one");
    expect(second).toContain("keep me");
    expect(second).toContain("## After");
  });

  it("is idempotent", () => {
    const once = upsertBlock("# Mine\n", body);
    expect(upsertBlock(once, body)).toBe(once);
  });
});
