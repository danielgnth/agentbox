import process from "node:process";
import { log } from "@clack/prompts";
import type { ArgsDef, CommandDef } from "citty";
import { UserError } from "./ui.ts";

/** Lazy subcommand that prints expected failures as one line (to stderr, so `token` keeps stdout clean). */
export function guarded<T extends ArgsDef>(load: () => Promise<{ command: CommandDef<T> }>) {
  return async (): Promise<CommandDef<T>> => {
    const { command } = await load();
    return {
      ...command,
      async run(ctx) {
        try {
          await command.run?.(ctx);
        } catch (e) {
          if (!(e instanceof UserError)) {
            throw e;
          }
          log.error(e.message, { output: process.stderr });
          process.exit(1);
        }
      },
    };
  };
}
