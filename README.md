# Hermes tools for KOSMU + Gmail

Tool definitions that let your **Hermes** AI agent platform read and write
**KOSMU** project data and create **Gmail** drafts.

## The simple model

You should only have to do two things:

1. In KOSMU: create a Hermes agent token and grant Hermes access to the projects
   it may touch.
2. On the Hermes VPS: install this connector once and give it:

```bash
KOSMU_API_BASE_URL=https://kosmu.vercel.app
KOSMU_AGENT_TOKEN=the-token-from-kosmu-settings
```

After that, permissions are controlled in KOSMU. If Hermes is added to a
project, the token can see and edit that project. If Hermes is removed, the same
token loses access. Hermes does not need Dario's login or password.

Never ask for a KOSMU password. Never use Playwright to log in as Dario for
normal outreach work. Spreadsheet contacts are written through
`import_contacts_to_project`, which calls KOSMU's token-scoped API and stores
rows in the Project's dynamic table system.

## One-command connection check

After installing the connector on the VPS:

```bash
cd integrations/hermes
npm install
npm run build

KOSMU_API_BASE_URL=https://kosmu.vercel.app \
KOSMU_AGENT_TOKEN=the-token-from-kosmu-settings \
npx hermes-kosmu-doctor
```

Expected output:

```text
Connection OK.
Visible projects: ...
```

For runtimes that cannot register JS tools directly, the fallback CLI is:

```bash
npx hermes-kosmu-call kosmu_search_projects '{"query":"email"}'
```

## Roles (keep these straight)

| System   | Role in this integration                                            |
| -------- | ------------------------------------------------------------------- |
| Hermes   | The agent orchestrator. Owns the agents, the planning, the loop.    |
| KOSMU    | The workspace, database, membership, and memory. Read and written, never "run". |
| Gmail    | Stores the final email drafts. Drafts only, never sent by an agent. |
| Telegram | Where the human talks to Hermes. Not called by these tools.         |

KOSMU is not an orchestrator. These tools never ask KOSMU to run an agent;
they store and retrieve state so Hermes agents stay coordinated and have
durable memory across runs.

## What is in here

```
integrations/hermes/
  tools.json          10 model-facing tool definitions (JSON Schema)
  src/
    types.ts          shared types + the OUTREACH_STATUSES enum + ToolResult
    kosmu-client.ts    9 KOSMU tools (typed fetch + error mapping)
    doctor.ts          connection check CLI
    call-tool.ts       generic tool invocation CLI
    gmail.ts           gmail_create_draft (drafts.create only, no send path)
    index.ts           kosmuHermesTools[]: defs bound to executors
  .env.example        required environment variables
  package.json        type:module, deps: googleapis
  tsconfig.json       strict, NodeNext
```

`tools.json` is what you feed the model. `kosmuHermesTools` pairs each
definition with an `execute(args)` function. Register both with your Hermes tool
layer; the model picks a tool by its JSON Schema, Hermes runs the matching
`execute`.

The full multi-agent outreach flow that drives these tools (research ->
contacts -> brief -> drafts) is in [`workflow/`](workflow/README.md): a
14-step state machine plus a system prompt per agent.

## Install and wire up

```bash
cd integrations/hermes
npm install
cp .env.example .env   # then fill it in
npm run check          # optional sanity check
```

```ts
import kosmuHermesTools from "./src/index.js";

for (const t of kosmuHermesTools) {
  hermes.registerTool({
    name: t.name,
    description: t.description, // t.when_to_use is extra guidance for your planner
    parameters: t.input_schema,
    run: t.execute, // (args) => Promise<ToolResult<...>>
  });
}
```

## The result envelope (read this once)

Every tool resolves to a `ToolResult`. It does **not** throw for expected API
outcomes. Agents branch on `ok`, and on failure inspect `error.code` and
`error.retryable`.

```ts
type ToolResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code: ToolErrorCode; message: string; retryable: boolean } };
```

| `error.code`        | Cause                                              | What the agent should do                              |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `invalid_request`   | 400 (or a local pre-check)                         | Fix the arguments. Do not retry unchanged.            |
| `unauthorized`      | 401 token mismatch                                 | Stop. Operator must fix `KOSMU_AGENT_TOKEN`.          |
| `not_found`         | 404 project/contact missing or token lacks access  | Re-resolve the id or add Hermes to the Project.       |
| `not_configured`    | 500 "Agent API not configured", or missing env     | Stop. Operator must set the KOSMU token / base URL.   |
| `migration_pending` | 500 "... not available"                            | Stop that feature. Operator must apply a migration.   |
| `internal`          | 500 server error                                   | Retry with backoff (few times), then surface.         |
| `network`           | fetch failed / timeout (status 0)                  | Retry with backoff (few times), then surface.         |

Only `internal` and `network` are `retryable: true`.

## Environment

See `.env.example`. Summary:

- `KOSMU_API_BASE_URL` — e.g. `https://kosmu.vercel.app` (no trailing slash).
- `KOSMU_AGENT_TOKEN` — the Hermes bearer token generated in KOSMU
  Settings -> Integrations. This must be the browser-generated token tied to the
  Hermes agent member. The connector intentionally does not accept
  `KOSMU_ADMIN_AGENT_TOKEN`, because that break-glass token can expose every
  admin-owned project.
- Gmail OAuth: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
  `GMAIL_OAUTH_REFRESH_TOKEN`, and `GMAIL_ACCOUNT_ID` (usually `me`). Minimal
  scope `https://www.googleapis.com/auth/gmail.compose`.

---

## Tool reference

All KOSMU tools authenticate with `Authorization: Bearer <KOSMU_AGENT_TOKEN>`.
For member-scoped tokens, KOSMU resolves the token to the Hermes agent member and
only exposes Projects where Hermes is a collaborator.

If `kosmu_search_projects` shows many unrelated projects, stop and fix the VPS
environment. Hermes is not using the scoped project-member token.

### 1. `kosmu_search_projects(query?)`

- **Purpose.** Find the KOSMU workspace to operate in, by title.
- **Input.** `{ query?: string }`. Empty/omitted returns the most recently
  updated projects (max 50).
- **Output.** `{ query: string, count: number, projects: AgentProjectSummary[] }`,
  where a summary is `{ id, title, description, project_type, created_at, updated_at }`.
  (No `status` field here; that is only in the context tool.)
- **Errors.** `unauthorized`, `not_configured`, `internal`, `network`.
- **When to use.** The first call when the operator names a project, or whenever
  you need a `projectId` for any other tool.

### 2. `kosmu_get_project_context(projectId)`

- **Purpose.** Load what already exists in a project before acting.
- **Input.** `{ projectId: string (uuid) }`.
- **Output.** `{ project: { id, title, description, project_type, status, created_at, updated_at }, notes[], databases[], contacts[], recent_activity[] }`.
  - `notes`: `{ id, title, content, created_at }` (max 50, newest first).
  - `databases`: Studio tables `{ id, name, created_at }` (max 50).
  - `contacts`: native Project Contacts table rows, when present. Use
    `kosmu_get_contacts` for filtering and dedup-sensitive reads.
  - `recent_activity`: last 20 activity log entries.
- **Errors.** `invalid_request` (bad uuid), `not_found`, `unauthorized`,
  `not_configured`, `internal`, `network`. Sub-fetches fail open, so a missing
  notes/activity table still returns the rest.
- **When to use.** After resolving a project, before planning or drafting, to
  reuse existing notes and decisions.

### 3. `kosmu_get_contacts(projectId, filters?)`

- **Purpose.** List a project's outreach contacts, optionally filtered.
- **Input.** `{ projectId: uuid, filters?: { category?, status?, outreach_status? } }`.
  Filters are exact-match. `outreach_status` must be one of the ten lifecycle
  values (see below).
- **Output.** `{ count: number, contacts: ProjectContact[] }` (max 1000, newest
  first). A `ProjectContact` includes the stored `outreach_status`,
  `campaign_brief_id`, and `gmail_*` ids.
- **Errors.** `invalid_request`, `not_found`, `unauthorized`, `not_configured`,
  `internal`, `network`.
- **When to use.** To pick the next batch to email
  (`outreach_status: "ready_to_pitch"`), to find follow-ups
  (`"follow_up_needed"`), and always before creating, to avoid duplicates.

### 4. `kosmu_create_contacts(projectId, contacts[], agentName?)`

- **Purpose.** Bulk-add contacts into the Project's native `Contacts` table,
  with server-side dedup.
- **Input.** `{ projectId: uuid, contacts: CreateContactInput[] (1..500), agent_name? }`.
  Each contact requires `company_name`; everything else is optional. `email`,
  if present, is validated; an empty string becomes null.
- **Output.** `{ created: ProjectContact[], created_count, skipped[], errors[] }`.
  - `skipped[i]`: `{ index, reason: "duplicate_email" | "duplicate_website" | "duplicate_company", company_name }`.
  - `errors[i]`: `{ index, error }` (per-row validation failure; the rest still insert).
- **Dedup + idempotency.** KOSMU skips duplicates by email, then website, then
  company_name, against existing rows and within the batch. Re-running an
  overlapping import is therefore safe; overlaps come back in `skipped`, not as
  new rows. Note: a fully-skipped call still returns HTTP 200 with
  `created_count: 0`.
- **Errors.** `invalid_request` (bad body, empty array, >500),
  `not_found`, `migration_pending`, `unauthorized`, `not_configured`,
  `internal`, `network`.
- **When to use.** After a research agent gathers prospects. Send the whole
  batch in one call and read `skipped`/`errors`.

### 5. `kosmu_create_campaign_brief(projectId, brief)`

- **Purpose.** Persist the human's campaign pitch/goal as a brief the Email
  Writer reads.
- **Input.** `{ projectId: uuid, brief: { pitch_goal (required), title?, offer?, ask?, target_categories?: string[], tone?, extra_context? } }`.
- **Output.** `{ campaign_brief: CampaignBrief }` (HTTP 201). The brief gets
  `status` and `created_by` defaults server-side. **Store `campaign_brief.id`.**
- **Idempotency.** None. Each call creates a new brief. Before creating, you can
  check existing briefs by reading them (the project context and contacts
  reference brief ids). Reuse an id rather than making near-duplicate briefs.
- **Errors.** `invalid_request`, `not_found`, `migration_pending`
  ("Campaign briefs not available"), `unauthorized`, `not_configured`,
  `internal`, `network`.
- **When to use.** Once per campaign, after the operator answers (on Telegram)
  what the campaign is about. Pass the returned id to contacts and to the Email
  Writer.

### 6. `import_contacts_to_project(project_name, table_name, contacts[])`

- **Purpose.** Import spreadsheet-shaped contact rows into a dynamic KOSMU table
  inside a named project.
- **Input.** `{ project_name, table_name, contacts, create_table_if_missing?, dedupe_by?, create_summary_note? }`.
  `contacts` is an array of row objects copied from a spreadsheet, CSV, Google
  Sheet, or research output.
- **Header normalization.** Common columns are mapped automatically:
  `Hotel`/`Brand`/`Company` -> `company_name`, `Email Address` -> `email`,
  `Website URL` -> `website`, `IG` -> `instagram`, `Contact Person` ->
  `contact_name`, `Position` -> `role`, `Notes` -> `personalization_notes`.
- **Output.** `{ project, table, inserted, updated, skipped, failed, failures, summary, note_created }`.
- **Dedup + idempotency.** KOSMU dedupes by email, website, and company name.
  Emails are lowercased, URLs are normalized, generic emails like `info@` and
  `hello@` are marked `Generic`, and rows with no email are marked
  `Unverified`.
- **When to use.** This is the default tool for Hermes spreadsheet/contact
  imports. Do not request the user's KOSMU credentials and do not use browser
  automation to populate Studio tables.

### 7. `kosmu_update_contact_outreach(projectId, contactId, outreachData)`

- **Purpose.** Record outreach status and Gmail metadata on a contact **after**
  a draft exists in Gmail. This is the contact's durable memory across runs.
- **Input.** `{ projectId: uuid, contactId: uuid, outreachData: {...} }`. Provide
  **at least one** of: `outreach_status` (enum), `campaign_brief_id`,
  `gmail_draft_id`, `gmail_thread_id`, `gmail_message_id`, `last_contacted_at`
  (ISO), `follow_up_date` (ISO), `reply_status`, `notes`.
- **Output.** `{ contact: ProjectContact }` (the updated row).
- **Cross-checks.** The contact must belong to the project (else `not_found`),
  and a supplied `campaign_brief_id` must belong to the same project (else
  `invalid_request`).
- **Idempotency.** Column values are idempotent (re-sending the same values
  leaves the same state), but every PATCH bumps `updated_at` and appends a new
  `contact_outreach_updated` activity entry, so repeated identical calls are not
  a true no-op. Do not poll it; call it when something actually changed.
- **Errors.** `invalid_request` (bad ids, bad enum, no fields,
  brief-not-in-project), `not_found`, `migration_pending` ("Campaign briefs not
  available" when a brief id is supplied but that table is not migrated),
  `unauthorized`, `not_configured`, `internal`, `network`.
- **When to use.** Immediately after `gmail_create_draft` (store the ids, set
  `outreach_status: "draft_created"`), then to advance the lifecycle as the
  operator reports progress.

### 8. `kosmu_log_activity(projectId, activity)`

- **Purpose.** Append to the shared, auditable agent activity trail.
- **Input.** `{ projectId: uuid, activity: { agent_name (required), action (required), summary?, metadata? } }`.
- **Output.** `{ activity: AgentActivityLog }` (HTTP 201).
- **Errors.** `invalid_request`, `not_found`, `migration_pending`
  ("Activity log not available"), `unauthorized`, `not_configured`, `internal`,
  `network`.
- **When to use.** After a meaningful step other agents or the operator should
  see (research finished, brief captured, drafts created). Keep `action` a short
  machine-ish verb and `summary` a one-line human sentence.

### 9. `kosmu_delete_project_table(projectId, tableId)`

- **Purpose.** Soft-delete one native KOSMU project table. This mirrors the
  human Delete table action: it sets `deleted_at`, it does not hard-delete rows
  or cells.
- **Input.** `{ projectId: uuid, tableId: uuid }`. Get table ids from
  `kosmu_get_project_context(...).data.databases`.
- **Output.** `{ deleted: true, table: { id, name, deleted_at } }`.
- **Safety.** Use only for explicit cleanup of retry-created or messy tables.
  Never delete intended tables such as `Contacts`, `Sponsor Outreach`,
  `Portugal Hotels`, or human-curated databases unless the operator names that
  exact table for removal.
- **Errors.** `invalid_request`, `not_found`, `unauthorized`,
  `not_configured`, `internal`, `network`.
- **When to use.** After inspecting `databases` and identifying accidental
  retry leftovers.

### 10. `gmail_create_draft(to, subject, body, threadId?)`

- **Purpose.** Create a **draft** email in the connected Gmail account.
- **Input.** `{ to (email), subject, body (plain text), threadId? }`.
- **Output.** `{ draft_id, message_id, thread_id }`.
- **Safety.** This tool only calls `users.drafts.create`. There is **no send
  path** anywhere in this toolset, so an agent cannot send mail. Sending stays a
  human action in Gmail. (Google has no draft-only-no-send OAuth scope, so the
  guarantee is structural in code, not enforced by the scope.)
- **Idempotency.** None. Calling twice creates two drafts. Before re-drafting,
  check the contact's stored `gmail_draft_id` (from `kosmu_get_contacts`).
- **Errors.** `invalid_request` (bad `to`), `unauthorized` (Gmail 401/403),
  `not_configured` (missing OAuth env), `internal`, `network`.
- **When to use.** When the Email Writer has a finished email. Create the draft,
  then immediately call `kosmu_update_contact_outreach` to store the returned ids
  and set `outreach_status: "draft_created"`.

---

## The outreach lifecycle

`outreach_status` uses exactly these ten values. The **`kosmu_update_contact_outreach`**
endpoint enforces them server-side (anything else is a 400). On
**`kosmu_create_contacts`**, the endpoint stores `outreach_status` as free text
(max 50 chars) and does not reject a non-lifecycle value; the tool schema lists
the enum as a client-side guardrail, so keep to these values everywhere even
though create will not bounce a typo:

```
new -> needs_email -> ready_to_pitch -> draft_created -> sent -> replied
                                                                   -> interested
                                                                   -> not_interested
                                          -> follow_up_needed ------^
                                          -> closed
```

Typical multi-agent flow:

1. **Research agent** finds prospects, `kosmu_create_contacts` (they default to
   `new`), then `kosmu_log_activity`.
2. Operator gives the campaign pitch on Telegram. Hermes calls
   `kosmu_create_campaign_brief` and keeps the brief id.
3. **Email Writer** reads `kosmu_get_contacts` (filter `ready_to_pitch`) and the
   brief, writes an email, `gmail_create_draft`, then
   `kosmu_update_contact_outreach` with the draft ids and `draft_created`.
4. Operator reviews drafts in Gmail and sends. As they report back, Hermes sets
   `sent`, then `replied` / `interested` / `not_interested` / `follow_up_needed`
   / `closed`, with `last_contacted_at`, `reply_status`, and `follow_up_date`.

Because KOSMU holds the status and the Gmail ids, any agent in any later run can
reconstruct exactly where each contact stands. That is the point of using KOSMU
as memory.

## Operational prerequisites (on the KOSMU side)

These tools are only live once the KOSMU deployment is configured:

1. Migrations `035_agent_tokens.sql` and `036_agent_members.sql` are applied.
2. Settings -> Integrations has a Hermes agent member and a generated token.
3. Hermes is added as an editor collaborator on the target KOSMU Project.
4. Optional migrations are applied: campaign briefs (`034`) for tool 5 and for
   tool 6 when a `campaign_brief_id` is supplied; activity logs (`032`) for
   tools 7 and 8. Until then, that feature returns `migration_pending`.
