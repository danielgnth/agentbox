import { beforeEach, describe, expect, test as it } from "bun:test";
import { join } from "node:path";
import { classify, originUrl, resolveRepo } from "../src/lib/resolve.ts";
import { fakeRepo, OWNER, useTempHome, write } from "./helpers.ts";

let home: string;
beforeEach(() => {
  home = useTempHome();
});

describe("classify", () => {
  it.each([
    ["ls -la", false, false],
    ["git status", false, false],
    ['git commit -m "push the thing"', false, false],
    ["cat github.md", false, false],
    ["bun run gh-pages", false, false],
    ["git push", true, false],
    ["git push -u origin agent/x", true, false],
    ["git -C ../other fetch", true, false],
    ["git -c core.hooksPath=/dev/null push", true, false],
    ["git --no-pager -C x push", true, false],
    ["git log --grep push", false, false],
    ["cd sub && git pull --rebase", true, false],
    ["git clone https://github.com/octo-dev/x", true, false],
    ["git submodule update --init", true, false],
    ["gh pr list", false, true],
    ["npm test; gh pr create --fill", false, true],
    ["agentbox github push", true, false],
    ["~/.local/bin/agentbox github push agent/x", true, false],
    ["agentbox github token alpha", false, false],
  ])("%s", (cmd, git, gh) => {
    expect(classify(cmd)).toEqual({ git, gh });
  });
});

describe("resolveRepo", () => {
  it("origin of cwd (https and ssh)", () => {
    const a = fakeRepo(join(home, "a"), `https://github.com/${OWNER}/alpha.git`);
    const b = fakeRepo(join(home, "b"), `git@github.com:${OWNER}/beta.git`);
    expect(resolveRepo("git push", a, OWNER)).toBe("alpha");
    expect(resolveRepo("git push", b, OWNER)).toBe("beta");
  });

  it("subdirectory of a checkout", () => {
    const a = fakeRepo(join(home, "a"), `https://github.com/${OWNER}/alpha`);
    expect(resolveRepo("git push", join(a, "src", "deep"), OWNER)).toBe("alpha");
  });

  it("-R / --repo win over cwd", () => {
    const a = fakeRepo(join(home, "a"), `https://github.com/${OWNER}/alpha`);
    expect(resolveRepo(`gh pr list -R ${OWNER}/other`, a, OWNER)).toBe("other");
    expect(resolveRepo(`gh pr list --repo=${OWNER}/other2`, a, OWNER)).toBe("other2");
  });

  it("clone URL", () => {
    expect(resolveRepo(`git clone https://github.com/${OWNER}/gamma.git`, home, OWNER)).toBe("gamma");
    expect(resolveRepo(`git clone git@github.com:${OWNER}/delta`, home, OWNER)).toBe("delta");
  });

  it("gh repo and gh api paths", () => {
    expect(resolveRepo(`gh repo clone ${OWNER}/eps`, home, OWNER)).toBe("eps");
    expect(resolveRepo(`gh api repos/${OWNER}/zeta/pulls`, home, OWNER)).toBe("zeta");
  });

  it("git -C and a leading cd use that directory", () => {
    fakeRepo(join(home, "work", "a"), `https://github.com/${OWNER}/alpha`);
    fakeRepo(join(home, "work", "b"), `https://github.com/${OWNER}/beta`);
    const a = join(home, "work", "a");
    expect(resolveRepo("git -C ../b push", a, OWNER)).toBe("beta");
    expect(resolveRepo('git -C "../b" push', a, OWNER)).toBe("beta");
    expect(resolveRepo("cd ../b && git push", a, OWNER)).toBe("beta");
    expect(resolveRepo("cd ../b\ngit push", a, OWNER)).toBe("beta");
    expect(resolveRepo("git -c x=y -C ../b push", a, OWNER)).toBe("beta");
    expect(resolveRepo("git -C ~/work/b push", a, OWNER)).toBe("beta");
  });

  it("owner match is case-insensitive", () => {
    const a = fakeRepo(join(home, "a"), `https://github.com/${OWNER.toUpperCase()}/alpha`);
    expect(resolveRepo("git push", a, OWNER)).toBe("alpha");
  });

  it("foreign repos and non-repos are ignored", () => {
    const f = fakeRepo(join(home, "f"), "https://github.com/someone-else/thing.git");
    expect(resolveRepo("git push", f, OWNER)).toBeUndefined();
    expect(resolveRepo("gh pr list -R someone-else/thing", f, OWNER)).toBeUndefined();
    expect(resolveRepo("git push", join(home, "nothing-here"), OWNER)).toBeUndefined();
    const g = fakeRepo(join(home, "g"), "https://gitlab.com/octo-dev/thing.git");
    expect(resolveRepo("git push", g, OWNER)).toBeUndefined();
  });

  it("rejects . and .. as repo names", () => {
    expect(resolveRepo(`git clone https://github.com/${OWNER}/..`, home, OWNER)).toBeUndefined();
  });
});

it("originUrl follows a worktree's .git file to the common config", () => {
  const main = fakeRepo(join(home, "main"), `https://github.com/${OWNER}/alpha.git`);
  write(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const wt = write(join(home, "wt", ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  expect(originUrl(join(wt, ".."))).toBe(`https://github.com/${OWNER}/alpha.git`);
});

it("resolves backslash-escaped spaces (iCloud paths)", () => {
  const spaced = fakeRepo(join(home, "Mobile Documents", "my repo"), `https://github.com/${OWNER}/spaced.git`);
  const escaped = spaced.replaceAll(" ", "\\ ");
  expect(resolveRepo(`cd ${escaped} && git push`, home, OWNER)).toBe("spaced");
  expect(resolveRepo(`git -C ${escaped} push`, home, OWNER)).toBe("spaced");
  expect(resolveRepo(`git -C "${spaced}" push`, home, OWNER)).toBe("spaced");
});
