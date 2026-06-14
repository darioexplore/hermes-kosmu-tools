#!/usr/bin/env node

import { kosmu_search_projects } from "./kosmu-client.js";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function redact(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const baseUrl = argValue("base-url");
const token = argValue("token");
const query = argValue("query") ?? "";

if (baseUrl) process.env.KOSMU_API_BASE_URL = baseUrl;
if (token) process.env.KOSMU_AGENT_TOKEN = token;

console.log("KOSMU Hermes connector doctor");
console.log(`Base URL: ${process.env.KOSMU_API_BASE_URL || "(missing)"}`);
console.log(`Token: ${redact(process.env.KOSMU_AGENT_TOKEN ?? process.env.KOSMU_ADMIN_AGENT_TOKEN)}`);

const result = await kosmu_search_projects({ query });

if (!result.ok) {
  console.error("Connection failed:");
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log("Connection OK.");
console.log(`Visible projects: ${result.data.count}`);
for (const project of result.data.projects.slice(0, 10)) {
  console.log(`- ${project.title} (${project.id})`);
}
