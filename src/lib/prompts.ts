// Prompt helpers for the setup wizard: free text with validation, and
// suggestion lists with an "Other…" escape.
import { log, select, text } from "@clack/prompts";
import { PATTERNS, type RawConfig } from "../config.ts";
import { answer } from "./ui.ts";

const OTHER = "\0other";

interface ChooseOptions {
  message: string;
  suggestions: Suggestion[];
  initial?: string;
  validate: Validator;
}

function dedupe(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    if (!s.value || seen.has(s.value)) {
      return false;
    }
    seen.add(s.value);
    return true;
  });
}

export interface Suggestion {
  value: string;
  hint?: string;
}

export type Validator = (value: string) => string | undefined;

export const LOGIN = PATTERNS.login;
export const NON_EMPTY_LINE = PATTERNS.line;
export const NO_SPACES = PATTERNS.noSpaces;
export const DIGITS = PATTERNS.digits;
export const COAUTHOR = PATTERNS.coauthor;

/** Valid when the trimmed value matches `pattern`; otherwise `hint` is shown. */
export function matches(pattern: RegExp, hint: string): Validator {
  return (value) => {
    if (pattern.test(value.trim())) {
      return;
    }
    return hint;
  };
}

/** Empty is fine; anything else must pass `inner`. */
export function optional(inner: Validator): Validator {
  return (value) => {
    if (!value.trim()) {
      return;
    }
    return inner(value);
  };
}

/** A string or number value from a table of the (possibly incomplete) current config. */
export function previous(raw: RawConfig | undefined, table: string, key: string): string | undefined {
  const section = raw?.[table];
  if (!section || typeof section !== "object") {
    return undefined;
  }
  const value = (section as Record<string, unknown>)[key];
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

/** Free text, prefilled with `initial`. */
export async function ask(message: string, initial: string | undefined, validate: Validator): Promise<string> {
  const value = await text({ message, initialValue: initial ?? "", validate: (v) => validate(v ?? "") });
  return answer(value).trim();
}

/** Picks one of the suggestions, or "Other…" for free text. Without suggestions it asks directly. */
export async function choose({ message, suggestions, initial, validate }: ChooseOptions): Promise<string> {
  const options = dedupe(suggestions);
  if (options.length === 0) {
    return ask(message, initial, validate);
  }
  let initialValue = options[0]?.value;
  if (initial && options.some((o) => o.value === initial)) {
    initialValue = initial;
  }
  const picked = answer(
    await select({
      message,
      options: [
        ...options.map((o) => ({ value: o.value, label: o.value, hint: o.hint })),
        { value: OTHER, label: "Other…" },
      ],
      initialValue,
    }),
  );
  if (picked !== OTHER) {
    return picked;
  }
  return ask(message, initial, validate);
}

export function openBrowser(url: string): void {
  log.info(`Opening ${url}`);
  Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
}
