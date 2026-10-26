import process from "node:process";
import { cancel, isCancel, spinner } from "@clack/prompts";

/** Exit status for Ctrl-C (128 + SIGINT). */
const EXIT_CANCELLED = 130;

/** An expected failure: printed without a stack trace. */
export class UserError extends Error {}

export function fail(message: string): never {
  throw new UserError(message);
}

/** The message of anything thrown. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/** Unwraps a clack prompt result, exiting cleanly on Ctrl-C / Esc. */
export function answer<T>(value: T | symbol): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(EXIT_CANCELLED);
  }
  return value as Exclude<T, symbol>;
}

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Runs `fn` behind a spinner; the spinner shows the failure if it throws. */
export async function step<T>(title: string, fn: () => Promise<T>, done?: string): Promise<T> {
  const s = spinner();
  s.start(title);
  try {
    const value = await fn();
    s.stop(done ?? title);
    return value;
  } catch (e) {
    s.error(title);
    throw e;
  }
}
