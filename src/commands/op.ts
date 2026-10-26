import process from "node:process";
import { defineCommand } from "citty";
import { loadConfig } from "../config.ts";
import { opEnv } from "../lib/op.ts";
import { need } from "../lib/proc.ts";

export const command = defineCommand({
  meta: {
    name: "op",
    description: "Run 1Password's op as the read-only service account (e.g. agentbox op vault list)",
  },
  async run({ rawArgs }) {
    const cfg = await loadConfig();
    const op = need("op", "brew install 1password-cli");
    const proc = Bun.spawn([op, ...rawArgs], { stdio: ["inherit", "inherit", "inherit"], env: await opEnv(cfg) });
    process.exit(await proc.exited);
  },
});
