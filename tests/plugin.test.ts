import assert from "node:assert/strict";
import { test } from "bun:test";
import McodePlugin from "../src/index.js";

test("registers the mcode tool and slash command without replacing user commands", async () => {
  const plugin = await McodePlugin({} as never);
  assert.ok(plugin.tool?.mcode);
  assert.ok(plugin.config);

  const config = { command: { existing: { template: "keep me" } } } as never;
  await plugin.config!(config);
  assert.equal((config as any).command.existing.template, "keep me");
  assert.match((config as any).command.mcode.template, /\$ARGUMENTS/);

  const userConfig = {
    command: { mcode: { template: "user command" } },
  } as never;
  await plugin.config!(userConfig);
  assert.equal((userConfig as any).command.mcode.template, "user command");
});
