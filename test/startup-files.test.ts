import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { setEnv } from "../src/lib/env.ts";
import { withDenyRules } from "../src/lib/managed.ts";
import { gitConfigFiles, startupFileRules, zdotdir } from "../src/lib/startup-files.ts";
import { useTempHome, write } from "./helpers.ts";

let home: string;

beforeEach(() => {
  home = useTempHome();
  setEnv("ZDOTDIR", undefined);
  setEnv("GIT_CONFIG_GLOBAL", undefined);
});

describe("zdotdir", () => {
  it("is HOME when nothing sets it", async () => {
    expect(await zdotdir()).toBe(home);
  });

  it("follows ZDOTDIR set in ~/.zshenv, even if .zshenv prints", async () => {
    write(join(home, ".zshenv"), 'echo hello\nexport ZDOTDIR="$HOME/.config/zsh-custom"\n');
    expect(await zdotdir()).toBe(join(home, ".config", "zsh-custom"));
  });

  it("follows an inherited ZDOTDIR", async () => {
    setEnv("ZDOTDIR", join(home, "dots"));
    expect(await zdotdir()).toBe(join(home, "dots"));
  });
});

describe("gitConfigFiles", () => {
  it("lists the default locations when there is no config", async () => {
    expect(await gitConfigFiles()).toEqual([join(home, ".gitconfig"), join(home, ".config", "git", "config")]);
  });

  it("follows includes, conditional and relative ones too, recursively", async () => {
    write(
      join(home, ".gitconfig"),
      ["[include]", "\tpath = ~/dots/main.cfg", '[includeIf "gitdir:~/work/"]', "\tpath = work.cfg", ""].join("\n"),
    );
    write(join(home, "dots", "main.cfg"), "[include]\n\tpath = nested/deep.cfg\n");
    const files = await gitConfigFiles();
    expect(files).toContain(join(home, "dots", "main.cfg"));
    expect(files).toContain(join(home, "work.cfg"));
    expect(files).toContain(join(home, "dots", "nested", "deep.cfg"));
  });

  it("adds GIT_CONFIG_GLOBAL", async () => {
    setEnv("GIT_CONFIG_GLOBAL", join(home, "elsewhere", "gitconfig"));
    expect(await gitConfigFiles()).toContain(join(home, "elsewhere", "gitconfig"));
  });
});

describe("startupFileRules", () => {
  it("covers the default zsh, bash, fish and git locations", async () => {
    const rules = await startupFileRules();
    for (const rule of [
      "Edit(~/.zshenv)",
      "Edit(~/.zshrc)",
      "Edit(~/.zlogin)",
      "Edit(~/.config/zsh/**)",
      "Edit(~/.bashrc)",
      "Edit(~/.profile)",
      "Edit(~/.config/fish/**)",
      "Edit(~/.gitconfig)",
      "Edit(~/.config/git/**)",
    ]) {
      expect(rules).toContain(rule);
    }
    expect(new Set(rules).size).toBe(rules.length);
  });

  it("follows ZDOTDIR, XDG_CONFIG_HOME and the global hooks path", async () => {
    write(join(home, ".zshenv"), 'export ZDOTDIR="$HOME/dots/zsh"\n');
    setEnv("XDG_CONFIG_HOME", join(home, "xdg"));
    write(join(home, ".gitconfig"), "[core]\n\thooksPath = ~/githooks\n");
    const rules = await startupFileRules();
    expect(rules).toContain("Edit(~/dots/zsh/**)");
    expect(rules).toContain("Edit(~/xdg/zsh/**)");
    expect(rules).toContain("Edit(~/xdg/fish/**)");
    expect(rules).toContain("Edit(~/xdg/git/**)");
    expect(rules).toContain("Edit(~/githooks/**)");
  });
});

describe("withDenyRules", () => {
  it("appends rules once, keeping the template's", () => {
    const settings = { permissions: { deny: ["Bash(sudo *)", "Edit(~/.zshrc)"] } };
    expect(withDenyRules(settings, ["Edit(~/.zshrc)", "Edit(~/.gitconfig)"])).toEqual({
      permissions: { deny: ["Bash(sudo *)", "Edit(~/.zshrc)", "Edit(~/.gitconfig)"] },
    });
    expect(settings.permissions.deny).toHaveLength(2);
  });
});
