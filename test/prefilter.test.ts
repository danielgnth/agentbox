// The dash prefilter must pass every event classify() cares about (a missed
// one means a git push without a token) and should drop everyday commands.
import { beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/lib/resolve.ts";
import { ROOT } from "./helpers.ts";

const EXECUTABLE = 0o755;
const PRETTY_INDENT = 2;
const SAMPLES = 400;
const MIN_RELEVANT = 50;
const MIN_WORDS = 2;
const EXTRA_WORDS = 6;
// A small deterministic LCG, so failures reproduce.
const SEED = 42;
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;
const LCG_MODULUS = 2_147_483_648; // 2^31

const WORDS = ["git", "gh", "push", "pull", "fetch", "clone", "ls-remote", "submodule", "status", "-C", "../x"];
const MORE_WORDS = ["pr", "list", "echo", "cd", "a", "&&", ";", "|", "(", "`"];
const GAPS = [" ", " ", " ", "\t", "\n", ""];

let dir: string;
const calls = () => join(dir, "calls");

/** Runs the prefilter on a hook event: its exit code and the input the binary got, if it was called. */
function prefilter(input: string): { code: number; received: string | undefined } {
  rmSync(calls(), { force: true });
  const r = Bun.spawnSync([join(dir, "hook")], { stdin: new Blob([input]) });
  let received: string | undefined;
  if (existsSync(calls())) {
    received = readFileSync(calls(), "utf8");
  }
  return { code: r.exitCode, received };
}

function event(command: string, pretty = false): string {
  const value = { session_id: "s", cwd: "/Users/me/src/app", tool_name: "Bash", tool_input: { command } };
  if (pretty) {
    return JSON.stringify(value, null, PRETTY_INDENT);
  }
  return JSON.stringify(value);
}

function randomCommands(count: number): string[] {
  const words = [...WORDS, ...MORE_WORDS];
  let seed = SEED;
  const rand = (n: number) => {
    seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return seed % n;
  };
  return Array.from({ length: count }, () =>
    Array.from(
      { length: MIN_WORDS + rand(EXTRA_WORDS) },
      () => (words[rand(words.length)] ?? "") + (GAPS[rand(GAPS.length)] ?? ""),
    ).join(""),
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbox-prefilter-"));
  copyFileSync(join(ROOT, "src", "hook.sh"), join(dir, "hook"));
  chmodSync(join(dir, "hook"), EXECUTABLE);
  // Stand-in for the binary: records the event it received.
  writeFileSync(join(dir, "agentbox"), `#!/bin/sh\ncat > "${calls()}"\n`, { mode: EXECUTABLE });
});

describe.skipIf(!existsSync("/bin/dash"))("hook prefilter: fixed cases", () => {
  it.each([
    "git push",
    "git push -u origin agent/x",
    "git -C ../other fetch",
    "cd sub && git pull --rebase",
    "git clone https://github.com/octo-dev/x",
    "git ls-remote origin",
    "git submodule update --init",
    "gh pr list",
    "npm test;gh pr create --fill",
    "(gh run watch)",
    "echo `gh pr view --json url`",
    "gh\tpr list",
    "make build\ngh pr create --fill",
    "git status\ngit push",
    "agentbox github push",
  ])("passes %j", (cmd) => {
    expect(classify(cmd).git || classify(cmd).gh).toBe(true);
    expect(prefilter(event(cmd))).toEqual({ code: 0, received: event(cmd) });
  });

  it.each(["ls -la", "git status", "git diff --stat", "bun test", "cat README.md", "rg TODO src"])(
    "drops %j",
    (cmd) => {
      expect(prefilter(event(cmd))).toEqual({ code: 0, received: undefined });
    },
  );

  it("passes multi-line JSON and input without a trailing newline", () => {
    expect(prefilter(event("git push", true)).received).toBe(event("git push", true).replaceAll("\n", ""));
    expect(prefilter(`${event("gh pr list")}\n`).received).toBe(event("gh pr list"));
  });
});

describe.skipIf(!existsSync("/bin/dash"))("hook prefilter: randomized", () => {
  it("never drops what classify() wants", () => {
    const relevant = randomCommands(SAMPLES).filter((cmd) => classify(cmd).git || classify(cmd).gh);
    const dropped = relevant.filter((cmd) => prefilter(event(cmd)).received === undefined);
    expect(relevant.length).toBeGreaterThan(MIN_RELEVANT);
    expect(dropped).toEqual([]);
  });
});
