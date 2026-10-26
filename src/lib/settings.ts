// Merges the managed template into ~/.claude/settings.json without
// overwriting anything agentbox doesn't manage.
//
//   - Scalars from the template win.
//   - Arrays are unions. Objects in arrays are matched by an id key
//     (path, name, matcher, command) and merged recursively.
//   - Entries from the previously applied template that the current one no
//     longer has are removed (like `kubectl apply`), as are known leftovers
//     from the hook prototype.
// Running it twice yields the same result.
import { rulePath } from "./paths.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Obj {
  [key: string]: Json;
}

interface Plan {
  current: Json;
  template: Json;
  lastApplied?: Json;
  legacy?: Json;
}

const ID_KEYS = ["path", "name", "matcher", "command"];
const GIT_CONFIG_KEY = /^GIT_CONFIG_KEY_(?<index>\d+)$/u;
const PLACEHOLDER = /\{\{(?<name>[A-Z_]+)\}\}/gu;
const TRAILING_NEWLINES = /\n*$/u;
const BEGIN = "<!-- agentbox:begin (managed by `agentbox setup`; edits here are overwritten) -->";
const BEGIN_PREFIX = "<!-- agentbox:begin";
const END = "<!-- agentbox:end -->";
const JSON_INDENT = 2;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T extends Json>(v: T): T => structuredClone(v);

function asArray(v: Json | undefined): Json[] {
  if (Array.isArray(v)) {
    return v;
  }
  return [];
}

function childOf(v: Json | undefined, key: string): Json | undefined {
  if (isObj(v)) {
    return v[key];
  }
  return undefined;
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function idKey(a: Json, b: Json): string | undefined {
  if (!(isObj(a) && isObj(b))) {
    return undefined;
  }
  return ID_KEYS.find((k) => k in a && k in b);
}

/** Same array entry: equal primitives, or objects with the same id. */
function same(a: Json, b: Json): boolean {
  const key = idKey(a, b);
  if (key) {
    return deepEqual((a as Obj)[key], (b as Obj)[key]);
  }
  return deepEqual(a, b);
}

function isEmpty(v: Json | undefined): boolean {
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  return isObj(v) && Object.keys(v).length === 0;
}

const bothContainers = (a: Json, b: Json) => (isObj(a) && isObj(b)) || (Array.isArray(a) && Array.isArray(b));

function merge(cur: Json | undefined, tmpl: Json): Json {
  if (isObj(cur) && isObj(tmpl)) {
    const out: Obj = { ...cur };
    for (const [k, v] of Object.entries(tmpl)) {
      out[k] = merge(out[k], v);
    }
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(tmpl)) {
    const out = [...cur];
    for (const t of tmpl) {
      const i = out.findIndex((c) => same(c, t));
      if (i < 0) {
        out.push(clone(t));
      } else {
        out[i] = merge(out[i], t);
      }
    }
    return out;
  }
  return clone(tmpl);
}

/** One object key: undefined drops it. */
function pruneValue(value: Json, prev: Json | undefined, tmpl: Json | undefined): Json | undefined {
  if (prev === undefined) {
    return value;
  }
  if (tmpl === undefined && deepEqual(value, prev)) {
    return undefined;
  }
  if (!bothContainers(value, prev)) {
    return value;
  }
  const pruned = prune(value, prev, tmpl);
  if (tmpl === undefined && isEmpty(pruned)) {
    return undefined;
  }
  return pruned;
}

/** One array entry: undefined drops it. Objects keep their id key and survive if the user added anything. */
function pruneItem(item: Json, prev: Json | undefined, kept: Json | undefined): Json | undefined {
  if (prev === undefined) {
    return item;
  }
  if (kept === undefined && deepEqual(item, prev)) {
    return undefined;
  }
  if (!(isObj(item) && isObj(prev))) {
    return item;
  }
  const key = idKey(item, prev);
  const idOnly: Obj = {};
  if (key) {
    idOnly[key] = item[key] as Json;
  }
  const pruned = prune(item, prev, kept ?? idOnly) as Obj;
  const userContent = Object.entries(pruned).some(([k, v]) => k !== key && !isEmpty(v));
  if (kept !== undefined || userContent) {
    return pruned;
  }
  return undefined;
}

/** Removes from `cur` what `last` contributed and `tmpl` no longer has. User additions stay. */
function prune(cur: Json, last: Json, tmpl: Json | undefined): Json {
  if (isObj(cur) && isObj(last)) {
    const out: Obj = {};
    for (const [k, value] of Object.entries(cur)) {
      const kept = pruneValue(value, last[k], childOf(tmpl, k));
      if (kept !== undefined) {
        out[k] = kept;
      }
    }
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(last)) {
    const t = asArray(tmpl);
    const out: Json[] = [];
    for (const item of cur) {
      const kept = pruneItem(
        item,
        last.find((x) => same(x, item)),
        t.find((x) => same(x, item)),
      );
      if (kept !== undefined) {
        out.push(kept);
      }
    }
    return out;
  }
  return cur;
}

/** GIT_CONFIG_COUNT must cover every GIT_CONFIG_KEY_<n>, including the user's own. */
function fixGitConfigCount(settings: Obj): void {
  const { env } = settings;
  if (!isObj(env)) {
    return;
  }
  let count = 0;
  for (const key of Object.keys(env)) {
    const index = GIT_CONFIG_KEY.exec(key)?.groups?.index;
    if (index !== undefined) {
      count = Math.max(count, Number(index) + 1);
    }
  }
  if (count > 0) {
    env.GIT_CONFIG_COUNT = String(count);
  }
}

/** Fills {{VAR}} placeholders in every string. Unknown placeholders are an error. */
function render(template: Json, vars: Record<string, string>): Json {
  if (typeof template === "string") {
    return template.replace(PLACEHOLDER, (_match, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        throw new Error(`template placeholder {{${name}}} has no value`);
      }
      return value;
    });
  }
  if (Array.isArray(template)) {
    return template.map((v) => render(v, vars));
  }
  if (isObj(template)) {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, vars)]));
  }
  return template;
}

/** Leftovers from the hook prototype (~/.claude/hooks/*). */
function legacySettings(home: string): Json {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell text "${HOME}" is what the prototype used.
  const homes = ["$HOME", "${HOME}", "~", home];
  const commands = homes.map((h) => ({ type: "command", command: `${h}/.claude/hooks/agent-gh-hook` }));
  return {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: commands }] },
    permissions: { deny: [`Edit(${rulePath(`${home}/.claude/hooks`)}/**)`] },
  };
}

function planSettings({ current, template, lastApplied, legacy }: Plan): Obj {
  let next: Json = {};
  if (isObj(current)) {
    next = current;
  }
  if (legacy !== undefined) {
    next = prune(next, legacy, template);
  }
  if (lastApplied !== undefined) {
    next = prune(next, lastApplied, template);
  }
  const merged = merge(next, template) as Obj;
  fixGitConfigCount(merged);
  return merged;
}

const stringify = (v: Json) => `${JSON.stringify(v, null, JSON_INDENT)}\n`;

/** Inserts or replaces the managed block in CLAUDE.md, leaving the rest alone. */
function upsertBlock(current: string, body: string): string {
  const block = `${BEGIN}\n${body.trim()}\n${END}`;
  const start = current.indexOf(BEGIN_PREFIX);
  const end = current.indexOf(END);
  if (start >= 0 && end > start) {
    return current.slice(0, start) + block + current.slice(end + END.length);
  }
  if (!current.trim()) {
    return `${block}\n`;
  }
  return `${current.replace(TRAILING_NEWLINES, "")}\n\n${block}\n`;
}

export type { Json, Plan };
export { deepEqual, legacySettings, merge, planSettings, prune, render, stringify, upsertBlock };
