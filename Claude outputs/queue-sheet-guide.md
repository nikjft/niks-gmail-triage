# Nik Queue sheet: how it works

Audience: Gemini, building a manual triage "canvas" over the queue sheet.
Source: the collector code in the Gmail, Slack and Trello triage repos, plus the Queue Processor and Nik Review skills (Notion, Nik Skills DB).

## 1. What the queue is

One Google Sheet holds every open loop that needs Nik: emails, Slack threads, Trello cards, and freeform instructions.

Collectors write rows in. Nik reviews them. A worker (Queue Processor) executes what is approved. Every row ends as Done.

Two tabs share one header:

- `Queue`: items Nik may need to act on or read.
- `Triage_Log`: items the model chose to ignore. Kind = Log, Status = Ignored. Read-only record for tracing "why did this not show up".

A row is one item at one moment. The sheet is the single source of truth.

## 2. Columns

System columns (the sheet fills them, never write them): `_uid`, `_created_at`, `_updated_at`. Use `_uid` to address a row.

| Column | Meaning | Written by |
|---|---|---|
| Name | Short title, e.g. `Email: Maya - Approve rename` | collector |
| Source | Gmail, Slack, Trello, Manual, Meeting | collector |
| Kind | Action, Brief, Log (also Research, Sprint exist in the processor contract) | collector, review |
| Status | Lifecycle state. See section 4 | everyone |
| Priority Tier | Now, Replies Ready, At Risk, Must-Do, Stretch, Later | collector, review |
| Entity | Client or company, from domain/channel/board maps. Often empty | collector |
| Reason | One-sentence gist plus markers. Ends with `[act:<ISO time>]` | collector, review, processor |
| Quote | Original wording (email body, Slack burst, comments) | collector |
| Source Ref | Link back to the item (Gmail thread URL, Slack permalink, `https://trello.com/c/<shortLink>`) | collector |
| Card Key | Stable identity of the underlying thing. See section 3 | collector |
| Flag Key | Identity of one due-date flag (Trello overdue). Example `trello:AbC123|due:2026-10-02|overdue` | collector |
| Check Date | The date the row should next be looked at (YYYY-MM-DD, Denver) | collector, review |
| Times Shown | How many review passes showed it untouched | review |
| Draft Text | Reply body for Email or Slack Action rows | processor, review |
| Draft Ref | Link or id of the draft or sent message once released | processor |
| Closeout | Why the row closed. Non-empty on every Done row | whoever closes |
| Closed At | Timestamp of closing | whoever closes |
| Lease | Worker claim stamp `queue-processor@<timestamp>`. Humans never edit | processor |
| Next Owner | Handoff flag. Only `Queue Processor` is used | review |
| Parent | `_uid` or link of the originating row, for child rows | review, processor |
| Importance | Model verdict: STAR, ACTION, FYI, IGNORE (Slack, Trello). STAR, UNSURE, ARCHIVE, BLOCK, NEITHER (Gmail) | collector |
| Reason Code | Short code, e.g. ASK_OF_NIK, CLIENT_ISSUE, OVERDUE, FORCED_DM, THIN_CONTEXT, RESOLVED_BY_NIK | collector |
| Notify | TRUE or FALSE. Model said Nik should be pinged | collector |
| Suggested Action | Concrete next step, up to about 15 words | collector |
| Who | The person waiting on Nik | collector |
| Open Ask | The ask in one sentence | collector |
| Context | Card detail, thread history, FACTS line. Long text | collector |
| Event Ts | Time of the triggering message or event | collector |
| Collector, Collector Version, Model | Provenance | collector |

## 3. How data gets in

### 3a. Collectors (automatic)

Three Apps Script tools run on time triggers: Gmail, Slack, Trello. Each classifies with Gemini and writes rows through the google-sheet-mcp web app webhook.

Webhook call:

```
POST <exec URL>?action=webhook&sheetName=Queue&apiKey=<key>
Content-Type: application/json
Body: [ { "Name": "...", "Source": "Slack", ... }, ... ]
```

Response: `{ insertedRows, ignoredFields, assignedIds }`. A field the header lacks comes back in `ignoredFields` and is dropped silently.

Hard facts for the canvas:

- **The webhook only inserts. It never updates.** A new reply on a known thread becomes a second row with the same Card Key. **The newest row per Card Key is current.** Show only that row. Treat older rows with the same Card Key as history.
- Card Key formats: `gmail:<threadId>`, `slack:<channelId>:<threadRootTs>`, `trello:<shortLink>`.
- Flag Key lets one Trello card carry several distinct overdue flags. Show one per Flag Key.
- The collectors dedupe on their side. They hold a seen-store and only advance their position after the write succeeds.
- What lands in `Queue`:
  - Gmail: STAR with a draft or action code becomes Action (tier Now if Notify, else At Risk). Other STAR becomes Brief. UNSURE becomes Brief, Later. ARCHIVE, BLOCK, NEITHER go to `Triage_Log`.
  - Slack: every human DM is forced to Queue (minimum FYI). Mentions, your threads, and `@here/@channel` go through Gemini. Action or Brief by verdict.
  - Trello: mentions and adds always reach Queue. Comments, moves, due changes go through Gemini. Overdue cards become Brief rows (Reason Code OVERDUE), at most once per business day.
  - Notifications on completed or archived Trello cards still come through. They are often QA requests. Overdue rows never do.
- New rows normally start Status = New. A Gmail or Slack row with a created draft starts as Drafted.

### 3b. Manual rows (Nik, or the canvas)

Insert a row with `Source = Manual`, `Kind = Action`, `Status = New`, the instruction verbatim in `Reason`. Leave everything else empty.

Queue Processor's directive intake reads it first on its next pass. It either routes it, turns it into a backlog item, or rewrites `Reason` into a direct question for Nik. Manual rows with Status New always show in Now.

### 3c. Child rows (review and processor)

Any instruction from Nik to do something becomes a new child row. Never a note on the source row.

Child shape: `Kind = Action`, `Source` = channel where the work happens, `Parent` = reviewed row, `Card Key` and `Source Ref` copied from the parent (a cross-channel child uses its own channel's key), `Reason` = the concrete ask, `Next Owner` empty. Status New (Processor will compose or execute). Use Approved with `Draft Text` only for finished, dictated text to an internal Slack target. Use Drafted for client-facing text.

Before creating a child, look for an open (not Done) row with the same Parent and Source, or the same Card Key. Update it instead of creating a duplicate.

## 4. Status lifecycle

| Status | Meaning | Who moves it |
|---|---|---|
| New | Waiting for a decision or for the processor | collector writes it |
| Drafted | Reply text composed in `Draft Text`, held for Nik | processor or collector |
| Approved | Nik reviewed and released it. The only trigger for sending | Nik |
| Waiting | Gmail or Slack draft created, Nik must send it himself | processor |
| Snoozed | Nik is still working on it. `Check Date` set | Nik |
| Done | Closed. `Closeout` and `Closed At` set | Nik, processor, sweep |
| Ignored | Triage_Log only | collector |
| Test | Test rows. Hide from the UI | manual |

Rules:

- Drafted and Approved are for Kind = Action only. A Brief ends as Done, Snoozed, or a new child Action.
- Never delete a row. Closing is a status change. The Done row is the record that stops the same item from coming back.
- Never archive Trello cards. This sheet never closes a Trello card itself.

## 5. How to set values (what a canvas edit means)

Update by `_uid`. Change only the fields you mean to change.

Reason markers (text prefixes the system reads):

| Marker | Meaning |
|---|---|
| `[needs help] ...` | A worker failed or stalled. Nik must decide. Always show in Now |
| `[send now] ...` | Nik wants client-facing text sent, not drafted. Needs recipient confirmed by name. One item only |
| `[new inbound - redraft]` | A new message arrived. The processor redrafts and resets to Drafted |
| `[repeat overdue: day k, n days overdue]` or `[repeat overdue: week w, ...]` | Repeated Trello overdue reminder. Ask: reschedule, delegate, eliminate, or keep |
| `[act:<ISO>]` at the end | Activity time token. Do not remove it |

`Check Date` is a "do not show before" date, format YYYY-MM-DD.

## 6. Canvas action map

Each action is one write to the row (plus a child row where noted).

| Nik action | Writes |
|---|---|
| Approve a draft as is | Status = Approved |
| Edit the draft, then approve | Draft Text = new text, Status = Approved |
| Send now (client-facing) | Status = Approved, Reason = `[send now] ` + existing Reason. Confirm the recipient name first |
| Kill, reject, no reply wanted | Status = Done, Closeout = `killed by Nik`, Closed At = now |
| Brief seen, nothing to do | Status = Done, Closeout = `reviewed`, Closed At = now |
| Snooze | Status = Snoozed, Check Date = chosen date (required) |
| Skip for now | Times Shown + 1. Status unchanged |
| Tell the system to do something | Insert child row (section 3c). Parent keeps its own state |
| Reschedule overdue card | Child: Source = Trello, Action, Card Key copied, Reason = `Set due date to <date>` |
| Delegate overdue card | Child: Reason = `Reassign card to <person>; remove Nik` |
| Eliminate overdue card | Child: Reason = `Prefix title NOT DOING:, mark complete, move to Review` |
| Keep overdue card for now | Status = Snoozed, Check Date = date Nik names (required) |
| Drop an instruction to the system | Insert Manual row (section 3b) |
| Acknowledge a `[needs help]` row | Strip the marker from Reason, or resolve it as above |

Every action that sets Status = Done must set `Closeout` (non-empty) and `Closed At` in the same write.

Audit trail: the Notion version leaves a comment per decision. This sheet has no comment column. Decide whether to add a `Review Note` column and write Nik's own words there.

## 7. How rows get picked up and actioned

Queue Processor is a worker. It never decides priority and never reroutes a Kind. It runs on a cadence (hourly Mon-Fri 5 AM-6 PM Denver, every 4 hours off-hours, none overnight on weekends).

Each pass runs in this order:

1. **Directive intake.** Manual rows, Status New. Route, convert to backlog, or turn into a question.
2. **Handoff intake.** Rows with `Next Owner = Queue Processor` become child rows.
3. **Staleness sweep.** Looks at Status New, Snoozed, Drafted (skips Approved, Waiting, leased, or Draft Ref set). Closes rows already handled outside the system:
   - Email: Nik or a teammate replied on the thread. Closeout `replied outside the system`.
   - Slack: Nik posted or reacted. Closeout `replied or reacted outside the system`. For Briefs, a teammate reply also closes it: `replied in thread by teammate`.
   - Trello: card complete (due complete, closed, in a Review, Completed*, Template* or NOT DOING list, or title starts `NOT DOING:`). Closeout `card complete in Trello`. Otherwise `resolved outside the system`.
   - Noise and duplicates: `suppressed: noise filter ...` and `merged into <row url>`.
4. **Claim and execute.** Takes Action rows with Status New, no Lease, not `[needs help]`, whose Source has a handler:
   - Email Action: composes the reply into Draft Text. Status = Drafted. Never creates the Gmail draft here.
   - Slack Action: composes the reply into Draft Text. Status = Drafted.
   - Trello Action: comments or updates the card directly, then Status = Done.
   - Research: hands off.
   Claim protocol: set `Lease = queue-processor@<timestamp>`, re-read to confirm it still holds, run, write results, clear Lease. A Lease older than 30 minutes counts as free.
5. **Release.** Takes Action rows with Status = Approved, empty Draft Ref:
   - Email: always a Gmail draft (`Waiting`), unless `[send now]`.
   - Slack client or external channel: a Slack draft (`Waiting`).
   - Slack internal channel or DM: sends with the agent marker. Status = Done, Closeout `sent in thread (internal)`.
   - Trello or Meeting: runs the Trello handler. Done.
   - Writes Draft Ref first, then Status and Closeout, then clears Lease.
6. **Failure loopback.** A failed step never becomes Done. It gets `[needs help]` at the start of Reason and shows up for Nik.

Rows the processor never touches: Brief rows (beyond the sweep), collector gate rows (`needs-help:trello-backlog` and similar), and rows in Approved or Waiting during the sweep.

## 8. How rows close

Every Done row has `Closed At` and a non-empty `Closeout`.

| Closeout | When |
|---|---|
| `killed by Nik` | Nik rejects a row or a Brief |
| `reviewed` | Nik saw a Brief, no action |
| `replied outside the system`, `replied or reacted outside the system`, `replied in thread by teammate` | Sweep found it handled |
| `card complete in Trello`, `resolved outside the system` | Sweep, Trello |
| `merged into <row url>` | Duplicate merged into the oldest open row |
| `suppressed: noise filter (heartbeat or ignored channel)` | Noise sweep |
| `sent in thread (internal)`, `sent by email`, `already sent` | Release |
| `send-now blocked, draft created` | Release, blocked by channel permission |
| `declined: <reason>` | Backlog gate declined |
| `repeat ended: <reason>` | Repeat overdue row ended |
| link to a backlog row | Capability request turned into a backlog item |

Fan-out rollup: when a child reaches Done, the processor checks the parent and every sibling. When all are Done, the parent becomes Done. A parent never closes early.

## 9. What Nik Review shows (the surface to mimic)

Show only the newest row per Card Key. Hide Status = Test, Ignored, Done.

**Eligibility filter.** Rows with Status New or Snoozed appear only when one of these holds. Drafted, Approved and Waiting always appear.

- Due date today or past, or within the next 2 business days.
- New activity since `Check Date`.
- `Check Date` is today or earlier.
- A Brief not yet shown.
- Source = Manual with Status New. Or Reason starts `[needs help]`. Or Reason starts `[repeat overdue`.
- Priority Tier is Now, At Risk or Must-Do.

Nik's standing rule: do not bring up snoozed or far-future items until 2 days before their Check Date or due date.

A row that does not clear the filter gets `Check Date` pushed: no due date means today + 7 days, a due date more than 7 days out means that date minus 7 days.

**Sections and hard caps**

1. **Now** (cap 5 ordinary rows). Uncapped and first: backlog gate rows, stale drafts (Drafted more than 24h), stalled releases (Approved, empty Draft Ref, more than 24h), `[needs help]` rows, Manual rows, high repeat overdue (show up to 10, then `+N more`).
2. **Replies Ready** (cap 8). Drafted Action rows for Nik to approve, edit or kill. `Waiting` rows over 48h move to Now as `waiting >48h`.
3. **At Risk** (cap 3).
4. **Briefs**, grouped by Entity, about 10 lines total.
5. **Upcoming** (one line): due in more than 2 and up to 7 days. No decisions asked.
6. **Sprint** (one line): today's Must-Do count.
7. **Counts** (one line).

**Presenting a row.** Lead with `Reason`. Show `Quote` next to it when present. Give enough context to decide: who, what happened, what is open. Use `Who`, `Open Ask`, `Suggested Action`, `Context`, `Source Ref`.

**Aging.** A row shown 3 times untouched forces a decision (act, snooze, or demote to Later). Increment `Times Shown` each time a row is shown. Reset to 0 on any Nik action or new activity. Repeat overdue rows and gate rows are exempt.

## 10. Gaps and unknowns to check before building

1. **Which sheet operations exist.** I know the webhook (insert) and the JSON-RPC `get_sheet_schema` call. I have not seen the google-sheet-mcp tool list for reading with filters or updating a row by `_uid`. Confirm those exist. The canvas needs: read rows with filters, update by `_uid`, insert.
2. **The processor and review skills are written for the Notion queue.** The collectors now write to this sheet. Until those skills are pointed at the sheet, the sheet rows are only acted on by the canvas. The field meanings above are the Notion contract, carried over.
3. **No atomic claim and no upsert.** Two writers can race on `Lease`. The canvas should not touch `Lease`.
4. **Header drift drops data.** A column missing from the header disappears without an error. Keep the header in step with the column list in section 2.
5. **Enum typos break the processor.** Use dropdown validation on Kind, Status, Priority Tier.
6. **Nothing here has run against live data yet.** The Gmail, Slack and Trello collectors are still in dry-run testing. Treat the values as the intended contract.
