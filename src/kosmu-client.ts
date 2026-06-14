/**
 * Typed client for the KOSMU Admin Agent API.
 *
 * One small surface: `kosmuFetch` makes the HTTP call, validates config,
 * enforces a timeout, and maps every outcome onto the normalized ToolResult
 * envelope. The exported `kosmu_*` functions are thin, validated wrappers the
 * Hermes agents call directly.
 *
 * Runtime: Node 18+ (uses global `fetch` / `AbortController`).
 */

import "dotenv/config";

import {
  OUTREACH_STATUSES,
  type BulkCreateContactsOutput,
  type ContactFilters,
  type ContactsListOutput,
  type CreateCampaignBriefInput,
  type CreateCampaignBriefOutput,
  type CreateContactInput,
  type DeleteProjectTableOutput,
  type ImportContactsToProjectInput,
  type ImportContactsToProjectOutput,
  type LogActivityInput,
  type LogActivityOutput,
  type OutreachStatus,
  type ProjectContextOutput,
  type SearchProjectsInput,
  type SearchProjectsOutput,
  type ToolError,
  type ToolFail,
  type ToolResult,
  type UpdateContactOutreachInput,
  type UpdateContactOutreachOutput,
} from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;

function fail(status: number, error: ToolError): ToolFail {
  return { ok: false, status, error };
}

function localInvalid(message: string): ToolFail {
  return fail(0, { code: "invalid_request", message, retryable: false });
}

interface KosmuConfig {
  baseUrl: string;
  token: string;
}

/** Read + sanity-check config from env. Returns a ToolFail if misconfigured so
 *  the agent gets a predictable "fix your setup" signal instead of a crash. */
function readConfig(): KosmuConfig | ToolFail {
  const baseUrl = (process.env.KOSMU_API_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.KOSMU_AGENT_TOKEN ?? "";
  if (!baseUrl) {
    return fail(0, {
      code: "not_configured",
      message: "KOSMU_API_BASE_URL is not set in the Hermes environment.",
      retryable: false,
    });
  }
  if (token.length < 24) {
    return fail(0, {
      code: "not_configured",
      message: "KOSMU_AGENT_TOKEN is missing or too short (need >= 24 chars).",
      retryable: false,
    });
  }
  return { baseUrl, token };
}

/** Map a KOSMU JSON error body + HTTP status onto a ToolError. */
function classify(status: number, bodyError: string | undefined): ToolError {
  const message = bodyError || `HTTP ${status}`;
  if (status === 400) return { code: "invalid_request", message, retryable: false };
  if (status === 401) return { code: "unauthorized", message, retryable: false };
  if (status === 404) return { code: "not_found", message, retryable: false };
  if (status >= 500) {
    if (bodyError === "Agent API not configured") {
      return { code: "not_configured", message, retryable: false };
    }
    // "Campaign briefs not available" / "Activity log not available"
    if (/ not available$/.test(bodyError ?? "")) {
      return { code: "migration_pending", message, retryable: false };
    }
    return { code: "internal", message, retryable: true };
  }
  return { code: "internal", message, retryable: true };
}

interface RequestOpts {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

async function kosmuFetch<T>(opts: RequestOpts): Promise<ToolResult<T>> {
  const cfg = readConfig();
  if ("ok" in cfg) return cfg; // ToolFail

  const url = new URL(cfg.baseUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v != null && v !== "") url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return fail(0, {
      code: "network",
      message: aborted ? "Request to KOSMU timed out." : `Network error: ${String(e)}`,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  // Parse JSON defensively — KOSMU always returns JSON, but a proxy might not.
  let parsed: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body
    }
  }

  if (res.ok) {
    return { ok: true, status: res.status, data: parsed as T };
  }
  const bodyError =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : undefined;
  return fail(res.status, classify(res.status, bodyError));
}

// ── Tool 1: search projects ─────────────────────────────────────────

export function kosmu_search_projects(
  input: SearchProjectsInput = {}
): Promise<ToolResult<SearchProjectsOutput>> {
  return kosmuFetch<SearchProjectsOutput>({
    method: "GET",
    path: "/api/admin/projects/search",
    query: { query: input.query?.trim() },
  });
}

// ── Tool 2: get project context ─────────────────────────────────────

export function kosmu_get_project_context(
  projectId: string
): Promise<ToolResult<ProjectContextOutput>> {
  if (!UUID_RE.test(projectId)) {
    return Promise.resolve(localInvalid("projectId must be a UUID."));
  }
  return kosmuFetch<ProjectContextOutput>({
    method: "GET",
    path: `/api/admin/projects/${projectId}/context`,
  });
}

// ── Tool 3: get contacts ────────────────────────────────────────────

export function kosmu_get_contacts(
  projectId: string,
  filters: ContactFilters = {}
): Promise<ToolResult<ContactsListOutput>> {
  if (!UUID_RE.test(projectId)) {
    return Promise.resolve(localInvalid("projectId must be a UUID."));
  }
  if (
    filters.outreach_status &&
    !OUTREACH_STATUSES.includes(filters.outreach_status as OutreachStatus)
  ) {
    return Promise.resolve(
      localInvalid(`outreach_status must be one of: ${OUTREACH_STATUSES.join(", ")}`)
    );
  }
  return kosmuFetch<ContactsListOutput>({
    method: "GET",
    path: `/api/admin/projects/${projectId}/contacts`,
    query: {
      category: filters.category,
      status: filters.status,
      outreach_status: filters.outreach_status,
    },
  });
}

// ── Tool 4: create contacts (bulk, deduped) ─────────────────────────

export function kosmu_create_contacts(
  projectId: string,
  contacts: CreateContactInput[],
  agentName = "hermes_agent"
): Promise<ToolResult<BulkCreateContactsOutput>> {
  if (!UUID_RE.test(projectId)) {
    return Promise.resolve(localInvalid("projectId must be a UUID."));
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return Promise.resolve(localInvalid("contacts must be a non-empty array."));
  }
  if (contacts.length > 500) {
    return Promise.resolve(localInvalid("contacts may contain at most 500 rows per call."));
  }
  const missing = contacts.findIndex((c) => !c?.company_name || !String(c.company_name).trim());
  if (missing !== -1) {
    return Promise.resolve(localInvalid(`contacts[${missing}] is missing company_name.`));
  }
  return kosmuFetch<BulkCreateContactsOutput>({
    method: "POST",
    path: `/api/admin/projects/${projectId}/contacts/bulk`,
    body: { contacts, agent_name: agentName },
  });
}

// ── Tool 5: create campaign brief ───────────────────────────────────

export function kosmu_create_campaign_brief(
  projectId: string,
  brief: CreateCampaignBriefInput
): Promise<ToolResult<CreateCampaignBriefOutput>> {
  if (!UUID_RE.test(projectId)) {
    return Promise.resolve(localInvalid("projectId must be a UUID."));
  }
  if (!brief?.pitch_goal || !String(brief.pitch_goal).trim()) {
    return Promise.resolve(localInvalid("brief.pitch_goal is required."));
  }
  return kosmuFetch<CreateCampaignBriefOutput>({
    method: "POST",
    path: `/api/admin/projects/${projectId}/campaign-briefs`,
    body: brief,
  });
}

// ── Tool 6: update contact outreach ─────────────────────────────────

const OUTREACH_KEYS: (keyof UpdateContactOutreachInput)[] = [
  "outreach_status",
  "campaign_brief_id",
  "gmail_draft_id",
  "gmail_thread_id",
  "gmail_message_id",
  "last_contacted_at",
  "follow_up_date",
  "reply_status",
  "notes",
];

export function kosmu_update_contact_outreach(
  projectId: string,
  contactId: string,
  outreachData: UpdateContactOutreachInput
): Promise<ToolResult<UpdateContactOutreachOutput>> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(contactId)) {
    return Promise.resolve(localInvalid("projectId and contactId must both be UUIDs."));
  }
  const provided = OUTREACH_KEYS.filter((k) => outreachData?.[k] !== undefined);
  if (provided.length === 0) {
    return Promise.resolve(localInvalid("Provide at least one outreach field to update."));
  }
  if (
    outreachData.outreach_status &&
    !OUTREACH_STATUSES.includes(outreachData.outreach_status)
  ) {
    return Promise.resolve(
      localInvalid(`outreach_status must be one of: ${OUTREACH_STATUSES.join(", ")}`)
    );
  }
  return kosmuFetch<UpdateContactOutreachOutput>({
    method: "PATCH",
    path: `/api/admin/projects/${projectId}/contacts/${contactId}/outreach`,
    body: outreachData,
  });
}

// ── Tool 7: log activity ────────────────────────────────────────────

export function kosmu_log_activity(
  projectId: string,
  activity: LogActivityInput
): Promise<ToolResult<LogActivityOutput>> {
  if (!UUID_RE.test(projectId)) {
    return Promise.resolve(localInvalid("projectId must be a UUID."));
  }
  if (!activity?.agent_name?.trim() || !activity?.action?.trim()) {
    return Promise.resolve(localInvalid("activity.agent_name and activity.action are required."));
  }
  return kosmuFetch<LogActivityOutput>({
    method: "POST",
    path: `/api/admin/projects/${projectId}/activity`,
    body: activity,
  });
}

// ── Tool 8: import spreadsheet contacts to a project table ──────────

interface AgentProjectByNameOutput {
  project: {
    id: string;
    title: string;
    description: string | null;
    project_type: "finite" | "ongoing" | null;
    status: string | null;
    created_at: string;
    updated_at: string;
  };
}

interface AgentTablesOutput {
  count: number;
  tables: { id: string; project_id: string; name: string; created_at: string; updated_at: string }[];
}

interface AgentCreateTableOutput {
  table: { id: string; project_id: string; name: string; created_at: string; updated_at: string };
}

interface AgentImportRowsOutput {
  table_id: string;
  table_name: string;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: { index: number; error: string }[];
  summary: string;
}

interface AgentCreateNoteOutput {
  note: { id: string; title: string; created_at: string };
}

export async function import_contacts_to_project(
  input: ImportContactsToProjectInput
): Promise<ToolResult<ImportContactsToProjectOutput>> {
  const projectName = input.project_name?.trim();
  const tableName = input.table_name?.trim();
  if (!projectName) return Promise.resolve(localInvalid("project_name is required."));
  if (!tableName) return Promise.resolve(localInvalid("table_name is required."));
  if (!Array.isArray(input.contacts) || input.contacts.length === 0) {
    return Promise.resolve(localInvalid("contacts must be a non-empty array."));
  }
  if (input.contacts.length > 1000) {
    return Promise.resolve(localInvalid("contacts may contain at most 1000 rows per call."));
  }

  const projectResult = await kosmuFetch<AgentProjectByNameOutput>({
    method: "GET",
    path: "/api/agent/projects/by-name",
    query: { name: projectName },
  });
  if (!projectResult.ok) return projectResult;

  const project = projectResult.data.project;
  const tablesResult = await kosmuFetch<AgentTablesOutput>({
    method: "GET",
    path: `/api/agent/projects/${project.id}/tables`,
  });
  if (!tablesResult.ok) return tablesResult;

  let table = tablesResult.data.tables.find(
    (candidate) => candidate.name.trim().toLowerCase() === tableName.toLowerCase()
  );
  if (!table) {
    if (input.create_table_if_missing === false) {
      return fail(404, {
        code: "not_found",
        message: `Table "${tableName}" was not found in project "${project.title}".`,
        retryable: false,
      });
    }
    const createResult = await kosmuFetch<AgentCreateTableOutput>({
      method: "POST",
      path: `/api/agent/projects/${project.id}/tables`,
      body: { name: tableName, type: "contacts", created_by: "hermes_agent" },
    });
    if (!createResult.ok) return createResult;
    table = createResult.data.table;
  }

  const columnsResult = await kosmuFetch<{ count: number }>({
    method: "POST",
    path: `/api/agent/tables/${table.id}/columns`,
    body: {},
  });
  if (!columnsResult.ok) return columnsResult;

  const importResult = await kosmuFetch<AgentImportRowsOutput>({
    method: "POST",
    path: `/api/agent/tables/${table.id}/import-rows`,
    body: {
      rows: input.contacts,
      dedupe_by: input.dedupe_by ?? ["email", "website", "company_name"],
      duplicate_strategy: "skip",
    },
  });
  if (!importResult.ok) return importResult;

  let note: ImportContactsToProjectOutput["note"] = null;
  if (input.create_summary_note !== false) {
    const noteResult = await kosmuFetch<AgentCreateNoteOutput>({
      method: "POST",
      path: `/api/agent/projects/${project.id}/notes`,
      body: {
        title: `Contact import: ${table.name}`,
        content: importResult.data.summary,
      },
    });
    if (noteResult.ok) note = noteResult.data.note;
  }

  await kosmu_log_activity(project.id, {
    agent_name: "hermes_agent",
    action: "contacts_spreadsheet_imported",
    summary: importResult.data.summary,
    metadata: {
      table_id: table.id,
      table_name: table.name,
      inserted: importResult.data.inserted,
      updated: importResult.data.updated,
      skipped: importResult.data.skipped,
      failed: importResult.data.failed,
    },
  });

  return {
    ok: true,
    status: importResult.status,
    data: {
      project,
      table: { id: table.id, name: table.name },
      inserted: importResult.data.inserted,
      updated: importResult.data.updated,
      skipped: importResult.data.skipped,
      failed: importResult.data.failed,
      failures: importResult.data.failures,
      summary: importResult.data.summary,
      note,
    },
  };
}

// ── Tool 9: delete one project table ────────────────────────────────

export function kosmu_delete_project_table(
  projectId: string,
  tableId: string
): Promise<ToolResult<DeleteProjectTableOutput>> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(tableId)) {
    return Promise.resolve(localInvalid("projectId and tableId must both be UUIDs."));
  }
  return kosmuFetch<DeleteProjectTableOutput>({
    method: "DELETE",
    path: `/api/admin/projects/${projectId}/tables/${tableId}`,
  });
}
