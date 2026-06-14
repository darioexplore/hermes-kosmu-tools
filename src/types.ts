/**
 * Shared types for the Hermes -> KOSMU Admin API integration.
 *
 * These mirror the wire contracts in the KOSMU app
 * (src/lib/admin/agent-api-types.ts). Keep them in sync if the API changes.
 */

// ── Normalized tool result envelope ─────────────────────────────────
//
// Every tool returns this shape, never throws for an expected API outcome.
// That is the whole point: a Hermes agent gets the SAME predictable
// structure whether the call succeeded, was rejected, or the network blipped,
// so routing logic ("retry? ask the human? move on?") is uniform.

export type ToolErrorCode =
  | "invalid_request" // 400 — arguments are wrong; fix them, do not retry as-is
  | "unauthorized" // 401 — token missing/wrong in Hermes config (operator fix)
  | "not_found" // 404 — project/contact not found or token lacks access
  | "not_configured" // 500 "Agent API not configured" — token unset in KOSMU env
  | "migration_pending" // 500 "... not available" — a KOSMU DB migration is not applied
  | "internal" // 500 — transient server error; safe to retry with backoff
  | "network"; // fetch failed / timed out; safe to retry with backoff

export interface ToolError {
  code: ToolErrorCode;
  /** Human-readable message, suitable for surfacing to the operator on Telegram. */
  message: string;
  /** True only for transient classes (internal, network). */
  retryable: boolean;
}

export interface ToolOk<T> {
  ok: true;
  status: number;
  data: T;
}

export interface ToolFail {
  ok: false;
  status: number; // HTTP status, or 0 for a network/timeout failure
  error: ToolError;
}

export type ToolResult<T> = ToolOk<T> | ToolFail;

// ── KOSMU resource shapes ───────────────────────────────────────────

export type ProjectType = "finite" | "ongoing" | null;

/** The ten outreach lifecycle states. KOSMU rejects anything else with a 400. */
export const OUTREACH_STATUSES = [
  "new",
  "needs_email",
  "ready_to_pitch",
  "draft_created",
  "sent",
  "replied",
  "interested",
  "not_interested",
  "follow_up_needed",
  "closed",
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/** Lightweight project summary (search results). Note: no `status` here. */
export interface AgentProjectSummary {
  id: string;
  title: string;
  description: string | null;
  project_type: ProjectType;
  created_at: string;
  updated_at: string;
}

export interface AgentNoteSummary {
  id: string;
  title: string;
  content: string | null;
  created_at: string;
}

export interface AgentDatabaseSummary {
  id: string;
  name: string;
  created_at: string;
}

export interface DeleteProjectTableOutput {
  deleted: true;
  table: {
    id: string;
    name: string;
    deleted_at: string;
  };
}

export interface AgentActivityLog {
  id: string;
  project_id: string | null;
  agent_name: string;
  action: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** A contact row from the native Project Contacts table. Status/outreach fields
 *  evolve, so treat strings as open except `outreach_status`, which KOSMU
 *  constrains to OutreachStatus. */
export interface ProjectContact {
  id: string;
  project_id: string;
  company_name: string;
  contact_name: string | null;
  role: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  linkedin: string | null;
  category: string | null;
  source_url: string | null;
  source_notes: string | null;
  relevance_score: number | null;
  notes: string | null;
  status: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  outreach_status: string | null;
  campaign_brief_id: string | null;
  gmail_draft_id: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  last_contacted_at: string | null;
  follow_up_date: string | null;
  reply_status: string | null;
}

export interface CampaignBrief {
  id: string;
  project_id: string;
  title: string | null;
  pitch_goal: string;
  offer: string | null;
  ask: string | null;
  target_categories: string[] | null;
  tone: string | null;
  extra_context: string | null;
  status: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── Tool input shapes ───────────────────────────────────────────────

export interface SearchProjectsInput {
  /** Title substring (case-insensitive). Omit/empty -> most recent projects. */
  query?: string;
}

export interface ContactFilters {
  category?: string;
  status?: string;
  outreach_status?: OutreachStatus;
}

export interface CreateContactInput {
  company_name: string; // required
  contact_name?: string | null;
  role?: string | null;
  email?: string | null;
  website?: string | null;
  instagram?: string | null;
  linkedin?: string | null;
  category?: string | null;
  source_url?: string | null;
  source_notes?: string | null;
  relevance_score?: number | null;
  notes?: string | null;
  status?: string | null;
  /** Per-contact attribution. Defaults to 'hermes_agent' server-side. */
  created_by?: string | null;
  /** Stored as free text (max 50) on create; the lifecycle enum is only
   *  enforced server-side by the outreach PATCH endpoint. */
  outreach_status?: OutreachStatus | null;
  campaign_brief_id?: string | null;
  follow_up_date?: string | null;
}

export interface CreateCampaignBriefInput {
  pitch_goal: string; // required
  title?: string | null;
  offer?: string | null;
  ask?: string | null;
  target_categories?: string[] | null;
  tone?: string | null;
  extra_context?: string | null;
}

export interface UpdateContactOutreachInput {
  outreach_status?: OutreachStatus;
  campaign_brief_id?: string | null;
  gmail_draft_id?: string | null;
  gmail_thread_id?: string | null;
  gmail_message_id?: string | null;
  last_contacted_at?: string | null; // ISO 8601
  follow_up_date?: string | null; // ISO 8601
  reply_status?: string | null;
  notes?: string | null;
}

export interface LogActivityInput {
  agent_name: string; // required (e.g. "research_agent", "email_writer")
  action: string; // required (short verb phrase, e.g. "contacts_imported")
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ImportContactsToProjectInput {
  project_name: string;
  table_name: string;
  contacts: Record<string, unknown>[];
  create_table_if_missing?: boolean;
  dedupe_by?: string[];
  create_summary_note?: boolean;
}

export interface ImportContactsToProjectOutput {
  project: AgentProjectSummary;
  table: { id: string; name: string };
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: { index: number; error: string }[];
  summary: string;
  note?: { id: string; title: string; created_at: string } | null;
}

// ── Tool output shapes ──────────────────────────────────────────────

export interface SearchProjectsOutput {
  query: string;
  count: number;
  projects: AgentProjectSummary[];
}

export interface ProjectContextOutput {
  project: {
    id: string;
    title: string;
    description: string | null;
    project_type: ProjectType;
    status: string | null;
    created_at: string;
    updated_at: string;
  };
  notes: AgentNoteSummary[];
  databases: AgentDatabaseSummary[];
  contacts: ProjectContact[];
  recent_activity: AgentActivityLog[];
}

export interface ContactsListOutput {
  count: number;
  contacts: ProjectContact[];
}

export interface BulkSkippedContact {
  index: number;
  reason: "duplicate_email" | "duplicate_website" | "duplicate_company";
  company_name: string | null;
}

export interface BulkContactError {
  index: number;
  error: string;
}

export interface BulkCreateContactsOutput {
  created: ProjectContact[];
  created_count: number;
  skipped: BulkSkippedContact[];
  errors: BulkContactError[];
}

export interface CreateCampaignBriefOutput {
  campaign_brief: CampaignBrief;
}

export interface UpdateContactOutreachOutput {
  contact: ProjectContact;
}

export interface LogActivityOutput {
  activity: AgentActivityLog;
}

export type DeleteProjectTableResult = DeleteProjectTableOutput;

export interface GmailDraftOutput {
  /** Gmail draft id — STORE THIS via kosmu_update_contact_outreach.gmail_draft_id. */
  draft_id: string;
  message_id: string;
  thread_id: string;
}
