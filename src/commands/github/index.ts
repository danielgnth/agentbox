import { defineCommand } from "citty";
import { guarded } from "../../lib/cli.ts";

export const command = defineCommand({
  meta: { name: "github", description: "GitHub App tokens for the agent (token, hook, credential, push)" },
  subCommands: {
    token: guarded(() => import("./token.ts")),
    hook: guarded(() => import("./hook.ts")),
    credential: guarded(() => import("./credential.ts")),
    push: guarded(() => import("./push.ts")),
  },
});
