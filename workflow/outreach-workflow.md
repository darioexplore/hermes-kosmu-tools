# KOSMU outreach workflow (Hermes)

The multi-agent flow Hermes runs when Dario says, on Telegram, something like
**"Find 20 contacts for my Outreach project."**

Hermes is the orchestrator. KOSMU is the memory (projects, contacts, briefs,
notes, statuses). Gmail holds the drafts. Telegram is the operator channel.

## Cast

| Agent                  | Owns                                                                 | KOSMU/Gmail tools it triggers                          |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **Hermes** (orchestrator) | Telegram I/O, the state machine, every tool call, the human gates, the no-send rule | all `kosmu_*` + `gmail_create_draft`                   |
| **Research Agent**     | Find relevant companies (web research)                              | none directly (returns candidates to Hermes)           |
| **Contact Agent**      | Find email, website, Instagram, LinkedIn, contact form, source URLs  | none directly                                          |
| **Database Agent**     | Dedup, relevance score, categorize, shape rows                       | none directly (reads existing contacts Hermes passed)  |
| **Email Writer Agent** | Personalized draft copy in Dario's voice                             | none directly (returns subject+body)                   |
| **Gmail Agent**        | Turn approved copy into Gmail drafts                                 | `gmail_create_draft`                                    |

Only Hermes calls KOSMU. The research/contact/email agents are pure
producers: they return data, Hermes persists it. This keeps one writer to
KOSMU and one clean audit trail.

> **Tool boundary.** The Research and Contact agents need Hermes-side web
> search / browsing tools (not provided by KOSMU). KOSMU's tools are for
> persistence and memory only. See `../tools.json` for the 8 tool contracts.

## The state machine

Each row is a state. `gate` marks a stop that waits for Dario on Telegram.

| #   | State               | Owner          | Action                                                                                          | Next                                  |
| --- | ------------------- | -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| 0   | `parse_command`     | Hermes         | Extract the project hint and the target count N from the message.                               | `search_projects`                     |
| 1   | `search_projects`   | Hermes         | `kosmu_search_projects({ query: projectHint })`.                                                | `select_project`                      |
| 2   | `select_project`    | Hermes (gate?) | Pick the best match. 0 matches -> tell Dario, stop. 1 clear -> go. >1 unclear -> **ask Dario.** | `load_context`                        |
| 3   | `load_context`      | Hermes         | `kosmu_get_project_context(projectId)`: notes, databases, categories, project_type.             | `load_existing`                       |
| 3b  | `load_existing`     | Hermes         | `kosmu_get_contacts(projectId)` for the real dedup set. (Context's `contacts` is always `[]`.)  | `research`                            |
| 4   | `research`          | Research Agent | Find ~N + buffer relevant companies, briefed by context + categories.                           | `enrich`                              |
| 5   | `enrich`            | Contact Agent  | For each: email, website, Instagram, LinkedIn, contact form, source URL.                         | `structure`                           |
| 6   | `structure`         | Database Agent | Dedup (vs existing + in-batch), score relevance, categorize, set status, shape rows.            | `save_contacts`                       |
| 7   | `save_contacts`     | Hermes         | `kosmu_create_contacts(projectId, contacts, "database_agent")`. Read created/skipped/errors.    | `log_research`                        |
| 8   | `log_research`      | Hermes         | `kosmu_log_activity` with a research summary (counts, categories, sources).                      | `ask_pitch`                           |
| 9   | `ask_pitch`         | Hermes **gate**| Telegram: "I added X draft contacts. What is the pitch about and what are your goals?"           | wait -> `save_brief`                  |
| 10  | `save_brief`        | Hermes         | `kosmu_create_campaign_brief(projectId, brief)` from Dario's answer. Keep `brief.id`.           | `write_emails`                        |
| 11  | `write_emails`      | Email Writer   | For each pitchable contact: personalized `{ subject, body }`, category-adapted, Dario's voice.  | `create_drafts`                       |
| 12  | `create_drafts`     | Gmail Agent    | `gmail_create_draft({ to, subject, body })` per email. Capture draft/thread/message ids.        | `update_outreach`                     |
| 13  | `update_outreach`   | Hermes         | Per contact: `kosmu_update_contact_outreach` with status `draft_created` + the ids + `brief.id`.| `log_drafts`                          |
| 13b | `log_drafts`        | Hermes         | `kosmu_log_activity`: drafts created summary.                                                    | `report_ready`                        |
| 14  | `report_ready`      | Hermes **end** | Telegram: "Drafts are ready for review in Gmail." Plus any that need a verified email. **No send.** | done                                  |

There is no send state anywhere. Sending is always Dario, by hand, in Gmail.

## Human gates (the only places Hermes pauses)

1. **`select_project`** — only when more than one project plausibly matches and
   the choice is not obvious. Present the candidates by title and let Dario pick.
   A single clear match proceeds without asking.
2. **`ask_pitch`** — always. Hermes will not invent the campaign. It saves
   contacts as drafts first, then asks for the pitch and goals, then writes.
3. **Implicit final review** — drafts sit in Gmail. Dario reviews and sends.
   This is the safety boundary, enforced structurally (the toolset has no send).

## Status mapping (important)

KOSMU constrains `outreach_status` on the PATCH endpoint to ten values:
`new, needs_email, ready_to_pitch, draft_created, sent, replied, interested,
not_interested, follow_up_needed, closed`. The workflow maps to them like this:

| Situation found in enrichment                          | `outreach_status` on create | Notes / fields                                                       | Drafted? |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------- | -------- |
| Verified personal/role email                           | `ready_to_pitch`            | email set                                                           | yes      |
| Only a generic inbox (info@, hello@), unverified       | `ready_to_pitch`            | email set; `notes` starts `[needs_verification] generic inbox; ...`  | yes, flagged |
| No email, only a contact form                          | `needs_email`               | `source_url` = form URL; `notes` `[needs_verification] contact form` | no       |
| No usable contact path at all                          | `needs_email`               | `notes` `[needs_verification] no contact found`                     | no       |

Rationale: the spec's "needs_verification" is not a KOSMU enum value, so it is
carried as a `[needs_verification]` prefix in `notes` (machine-greppable) while
`outreach_status` stays a real lifecycle value. Contacts that cannot be drafted
(`needs_email`) are reported to Dario at the end, never silently dropped.
Generic-inbox contacts ARE drafted (the rule says use a generic email when
needed), but the final Telegram message names how many use a generic inbox so
the unverified flag is visible, not buried in `notes`.

> Want `needs_verification` as a first-class status instead? It is a two-line
> change in KOSMU (`OUTREACH_STATUSES` + `OutreachUpdateSchema`). Say so and it
> can be added; until then the convention above is the safe path.

## Data flow that is easy to get wrong

Four places where the wiring matters more than it looks:

1. **Contact ids come from the save, not before it.** The pre-save rows have no
   ids. `kosmu_create_contacts` returns `created[]` with real ids. The Email
   Writer and the outreach update must use those `created` rows, filtered to
   `ready_to_pitch` with an email. Skipped duplicates are not in `created` and
   are not drafted this run (they already exist).
2. **The Email Writer gets the full brief object, not its id.** It has no tool
   to fetch a brief. Pass the `campaign_brief` object returned by
   `kosmu_create_campaign_brief`; keep `brief.id` separately for the step-13
   link. A bare id makes the writer invent the campaign and defeats the pitch
   gate.
3. **`draft_created` requires a real `gmail_draft_id`.** Only Gmail results with
   `ok: true` and a non-empty `draft_id` flow into the outreach update. A failed
   draft leaves the contact at `ready_to_pitch`. `kosmu_update_contact_outreach`
   would accept a status-only update, so this invariant is enforced in the flow,
   not by the API.
4. **The outreach update overwrites `notes`.** Step 13 does not send `notes`, so
   the Database Agent's `[needs_verification]` flag survives. If you ever set
   `notes` on an update, re-include the existing flag or it is lost.

The free-text pitch reply is interpreted by Hermes into the brief fields;
`pitch_goal` (the one required field) is never empty: if nothing structured can
be extracted, it falls back to the full answer text.

## Rules, and where each is enforced

| Rule                                              | Enforced at                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| Never send emails automatically                   | Structural: no send tool exists. `gmail_create_draft` only drafts. End state stops at "ready for review". |
| Always save contacts as draft first               | State 7 (`save_contacts`) runs before any email work (states 11+).          |
| Avoid duplicate contacts                          | State 3b loads existing; state 6 dedups; `kosmu_create_contacts` dedups server-side too. |
| No email -> contact form / generic, needs_verification | State 6 status mapping above.                                          |
| Always store source URLs                          | State 5 captures `source_url`; state 6 includes it on every row.            |
| Always update KOSMU activity                      | States 8 and 13b call `kosmu_log_activity`.                                  |
| Keep Telegram messages short and useful           | Hermes orchestrator prompt: gates 9 and 14 are one or two lines, no fluff.  |

## Count handling

"Find 20 contacts" sets N = 20 **usable** contacts. Research targets N plus a
buffer (about 1.4x) so dedup skips and dead-end enrichments still net ~N. The
final Telegram message reports the real numbers: added, skipped as duplicates,
and how many need a verified email.

## Failure handling

- A `kosmu_*` call returns the normalized `ToolResult`. On `not_configured` or
  `migration_pending`, Hermes stops and tells Dario exactly what to fix (token
  in Vercel, or apply a migration). It does not retry those.
- On `network` / `internal`, retry with backoff a few times, then surface.
- If `kosmu_create_contacts` returns `errors[]`, Hermes reports the count and
  keeps the successful rows; it does not abort the run.
- If the Gmail draft fails for one contact, that contact stays `ready_to_pitch`
  (no false `draft_created`), and Hermes reports which ones failed.

## Agent prompts

System prompts are in `agents/`:

- `00-hermes-orchestrator.md`
- `01-research-agent.md`
- `02-contact-agent.md`
- `03-database-agent.md`
- `04-email-writer-agent.md`
- `05-gmail-agent.md`

The machine-readable version of this state machine is
`outreach-workflow.json`.
