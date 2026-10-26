// agentbox: GitHub App tokens and Claude Code sandbox settings for coding agents.
import { defineCommand, runMain } from "citty";
import { BUILD } from "./lib/build.ts";
import { guarded } from "./lib/cli.ts";

const main = defineCommand({
  meta: {
    name: "agentbox",
    version: BUILD,
    description: "GitHub App tokens and Claude Code sandbox settings for coding agents",
  },
  subCommands: {
    install: guarded(() => import("./commands/install.ts")),
    setup: guarded(() => import("./commands/setup.ts")),
    doctor: guarded(() => import("./commands/doctor.ts")),
    github: () => import("./commands/github/index.ts").then((m) => m.command),
    op: guarded(() => import("./commands/op.ts")),
    version: guarded(() => import("./commands/version.ts")),
  },
});

await runMain(main);
