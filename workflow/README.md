# KOSMU outreach workflow

The multi-agent flow Hermes runs to research contacts, save them to KOSMU, and
prepare Gmail drafts for review. Built on the 8 tools in `../tools.json`.

```
workflow/
  outreach-workflow.md     master spec: 14-step state machine, gates, rules, status mapping
  outreach-workflow.json   machine-readable state machine (states, tools, gates, guards)
  agents/
    00-hermes-orchestrator.md   coordinator: Telegram, tool calls, gates, no-send rule
    01-research-agent.md        find relevant companies
    02-contact-agent.md         find email / website / socials / form / source URLs
    03-database-agent.md        dedup, score, categorize, shape rows
    04-email-writer-agent.md    personalized drafts in Dario's voice, category-adapted
    05-gmail-agent.md           create Gmail drafts (drafts only)
```

## Trigger

Dario on Telegram: "Find 20 contacts for my Outreach project." Hermes runs the
state machine and pauses only at two gates: project disambiguation (only when
unclear) and the pitch question (always). Drafts land in Gmail for review.
Nothing is ever sent by an agent.

## How to wire it into Hermes

1. Register the 8 tools from `../src/index.ts` (`kosmuHermesTools`).
2. Load each `agents/*.md` as the system prompt for that agent.
3. Drive the agents with `outreach-workflow.json` (or follow
   `outreach-workflow.md` if your orchestrator is prompt-driven). The
   orchestrator prompt (`agents/00-...`) already encodes the full sequence, so a
   capable single coordinator can run it without the JSON.
4. Fill the Email Writer placeholders: `{{DARIO_PORTFOLIO_URL}}`,
   `{{DARIO_SIGNATURE}}`, `{{DARIO_RECENT_WORK}}`.

## Two contract notes (read once)

- **Dedup source.** Existing contacts for dedup come from `kosmu_get_contacts`,
  not from `kosmu_get_project_context` (whose `contacts` is always `[]`). The
  workflow already does this at state `load_existing`.
- **`needs_verification`.** It is not a KOSMU `outreach_status` value, so the
  workflow stores it as a `[needs_verification]` prefix in `notes` while
  `outreach_status` stays a real lifecycle value (`ready_to_pitch` for a usable
  email, `needs_email` when there is no address). If you would rather have it as
  a first-class status, it is a small change in KOSMU's `OUTREACH_STATUSES` and
  `OutreachUpdateSchema`.

## What needs KOSMU-side setup

The same prerequisites as the tools: `KOSMU_ADMIN_AGENT_TOKEN` set in Vercel,
and migrations applied (contacts `033` is live; campaign briefs `034` is still
pending, needed at state `save_brief`). See `../README.md`.
