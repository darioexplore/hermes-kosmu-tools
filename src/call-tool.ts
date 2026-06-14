#!/usr/bin/env node

import kosmuHermesTools from "./index.js";

function usage(): never {
  console.error(`Usage:
  hermes-kosmu-call <tool_name> '<json_args>'

Example:
  hermes-kosmu-call kosmu_search_projects '{"query":"email outreach"}'
`);
  process.exit(2);
}

const [, , toolName, rawArgs] = process.argv;
if (!toolName) usage();

const tool = kosmuHermesTools.find((candidate) => candidate.name === toolName);
if (!tool) {
  console.error(`Unknown tool: ${toolName}`);
  console.error(`Available tools: ${kosmuHermesTools.map((candidate) => candidate.name).join(", ")}`);
  process.exit(2);
}

let args: Record<string, unknown> = {};
if (rawArgs) {
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid JSON arguments");
    process.exit(2);
  }
}

const result = await tool.execute(args);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
