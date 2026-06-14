/**
 * Hermes tool registry for KOSMU + Gmail.
 *
 * `kosmuHermesTools` is an array of 9 tool definitions, each with a JSON-Schema
 * `input_schema` (the same one shipped in tools.json) and an `execute` function
 * that returns the normalized ToolResult envelope. Register them with whatever
 * tool-calling layer Hermes uses; the JSON Schema is model-facing, `execute` is
 * the side-effecting call.
 *
 * Design rules baked in:
 *  - KOSMU is the workspace/memory. It is read and written here, never told to
 *    "run an agent". Orchestration stays in Hermes.
 *  - Gmail stores drafts only. There is no send tool in this registry.
 *  - Every tool returns ToolResult — agents branch on `result.ok` and, on
 *    failure, on `result.error.code` / `result.error.retryable`.
 */

import toolSchemas from "../tools.json" with { type: "json" };
import {
  kosmu_create_campaign_brief,
  kosmu_create_contacts,
  kosmu_delete_project_table,
  kosmu_get_contacts,
  kosmu_get_project_context,
  import_contacts_to_project,
  kosmu_log_activity,
  kosmu_search_projects,
  kosmu_update_contact_outreach,
} from "./kosmu-client.js";
import { gmail_create_draft } from "./gmail.js";
import type { ToolResult } from "./types.js";

export * from "./types.js";
export {
  kosmu_search_projects,
  kosmu_get_project_context,
  kosmu_get_contacts,
  kosmu_create_contacts,
  import_contacts_to_project,
  kosmu_create_campaign_brief,
  kosmu_update_contact_outreach,
  kosmu_log_activity,
  kosmu_delete_project_table,
} from "./kosmu-client.js";
export { gmail_create_draft } from "./gmail.js";

export interface ToolSchema {
  name: string;
  description: string;
  when_to_use: string;
  input_schema: Record<string, unknown>;
}

export interface HermesTool {
  name: string;
  description: string;
  when_to_use: string;
  input_schema: Record<string, unknown>;
  /** Side-effecting executor. `args` matches `input_schema`. Always resolves
   *  to a ToolResult; it does not throw for expected API failures. */
  execute: (args: Record<string, unknown>) => Promise<ToolResult<unknown>>;
}

const schemas = toolSchemas as { tools: ToolSchema[] };

function schema(name: string): ToolSchema {
  const s = schemas.tools.find((t) => t.name === name);
  if (!s) throw new Error(`tools.json is missing a definition for "${name}"`);
  return s;
}

/** Bind a typed executor to its JSON-Schema definition from tools.json. */
function tool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<ToolResult<unknown>>
): HermesTool {
  const s = schema(name);
  return {
    name: s.name,
    description: s.description,
    when_to_use: s.when_to_use,
    input_schema: s.input_schema,
    execute,
  };
}

export const kosmuHermesTools: HermesTool[] = [
  tool("kosmu_search_projects", (a) =>
    kosmu_search_projects({ query: a.query as string | undefined })
  ),
  tool("kosmu_get_project_context", (a) =>
    kosmu_get_project_context(a.projectId as string)
  ),
  tool("kosmu_get_contacts", (a) =>
    kosmu_get_contacts(a.projectId as string, (a.filters as never) ?? {})
  ),
  tool("kosmu_create_contacts", (a) =>
    kosmu_create_contacts(
      a.projectId as string,
      (a.contacts as never) ?? [],
      a.agent_name as string | undefined
    )
  ),
  tool("kosmu_create_campaign_brief", (a) =>
    kosmu_create_campaign_brief(a.projectId as string, (a.brief as never) ?? {})
  ),
  tool("kosmu_update_contact_outreach", (a) =>
    kosmu_update_contact_outreach(
      a.projectId as string,
      a.contactId as string,
      (a.outreachData as never) ?? {}
    )
  ),
  tool("kosmu_log_activity", (a) =>
    kosmu_log_activity(a.projectId as string, (a.activity as never) ?? {})
  ),
  tool("import_contacts_to_project", (a) => import_contacts_to_project(a as never)),
  tool("kosmu_delete_project_table", (a) =>
    kosmu_delete_project_table(a.projectId as string, a.tableId as string)
  ),
  tool("gmail_create_draft", (a) =>
    gmail_create_draft({
      to: a.to as string,
      subject: a.subject as string,
      body: a.body as string,
      threadId: a.threadId as string | undefined,
    })
  ),
];

export default kosmuHermesTools;
