import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Replaced by `bun build --define` in `agentbox install`.
declare const AGENTBOX_BUILD: string | undefined;

const SOURCES = ["src", "claude", "package.json", "bun.lock"];
const HASH_LENGTH = 16;

function buildId(): string {
  if (typeof AGENTBOX_BUILD === "string") {
    return AGENTBOX_BUILD;
  }
  return "dev";
}

export const BUILD = buildId();

/** Hash of everything that goes into the build, to tell whether the installed copy is current. */
export function sourceHash(root: string): string {
  const files: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) {
      return;
    }
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        walk(join(path, entry));
      }
    } else {
      files.push(path);
    }
  };
  for (const s of SOURCES) {
    walk(join(root, s));
  }
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  }
  return hash.digest("hex").slice(0, HASH_LENGTH);
}
