// The one module that reads or changes the environment; everything else goes through it.
import process from "node:process";

// biome-ignore lint/style/noProcessEnv: the single, intentional access point.
const vars = process.env;

/** An environment variable; empty counts as unset. */
export const env = (name: string): string | undefined => vars[name] || undefined;

/** A copy of the environment, for child processes. */
export const environment = (): Record<string, string | undefined> => ({ ...vars });

/** Sets or (with undefined) removes a variable. Tests use this to point HOME at a temp dir. */
export function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(vars, name);
  } else {
    vars[name] = value;
  }
}
