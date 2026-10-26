import process from "node:process";
import { defineCommand } from "citty";
import { BUILD } from "../lib/build.ts";

export const command = defineCommand({
  meta: { name: "version", description: "Print the build id (dev when run from the repo)" },
  run() {
    process.stdout.write(`${BUILD}\n`);
  },
});
