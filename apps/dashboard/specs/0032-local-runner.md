# The local runner — rankloop on a laptop

## Status

Accepted (August 2026). Ships as `packages/local`, bin `rankloop-local`.

## Why

The dashboard is a Cloudflare Worker even on localhost — workerd has no
`child_process`, so it can never call a CLI. But everything the user asked
for ("if it's installed on a laptop it should use the CLI, crons, direct AI
from the CLI instead of an API") is one small Node process away, because
the agent path (spec 0023) already built the machine surface:

    rankloop_status          what the loop owes today
    rankloop_proposals       approved and unwritten, with evidence
    rankloop_brief           the grounded prompt (SERP, links, voice, laws)
    rankloop_check           the 15 laws as data — free, call it in a loop
    rankloop_publish_report  record a shipped page, open its receipt

What was missing is the daemon that drives it unattended. That is this
package: a zero-dependency Node process that polls rankloop over MCP,
spawns the user's own AI CLI to write, feeds violations back until the
laws pass, ships the file into the local repo, and reports it — on a cron.

`AUTH_MODE=local_noauth` resolves the local admin workspace on `/mcp` with
no token, so on a laptop the runner needs no credentials at all: not for
rankloop, and not for the model — the writer is whatever CLI the user
already pays for (`claude -p` by default), so the marginal cost per
article is zero.

## The loop (one `run --once`)

    status      → writerMode must be "agent"; otherwise say where to flip it
    proposals   → approved rows whose article is null; take up to --max
    per proposal:
      state?    → resume where an interrupted run stopped (see State)
      brief     → cached grounding by default; --buy-serp opts into the one
                  thing a brief can spend money on
      write     → spawn the configured CLI, brief on stdin, draft on stdout
      check     → the laws grade it server-side
      fail      → re-spawn with the failed-laws table + previous draft,
                  "fix only what the violations require" — up to maxAttempts
      pass      → repo mode: write content/<dir>/<slug>.md, commit, push,
                  poll the URL until it is live, THEN publish_report
               → draft mode: write the gated file to --out and stop

`--watch --every 30m` wraps that in a loop; `rankloop-local cron` prints
the crontab and launchd lines for `--once`.

## The honesty rules

1. **Report only what was observed live.** `rankloop_publish_report` opens
   a receipt against a URL; calling it before that URL answers 200 records
   a publish that has not happened. The runner polls after pushing and, on
   timeout, stops at state `pushed` — the next run resumes at verification,
   not at writing.
2. **Never write the same article twice.** A state file
   (`~/.config/rankloop/local-state.json`) records
   `drafted → written → pushed → reported` per proposal. Cron means
   interrupted runs are normal, and rankloop still lists a proposal as
   unwritten until the report lands — without local state, every crash
   costs a duplicate generation and a duplicate file.
3. **Never overwrite a file the runner did not create.** A path that exists
   without a matching state entry is somebody's work; the runner refuses
   and says so.
4. **The grader is never the author**, now as process isolation: the writer
   is the user's CLI process, the laws run inside the server, and the
   check on submit is the same engine that `publish_report` re-runs.
5. **The prompt goes over stdin.** Not argv — no shell, no escaping, no
   length limit, and nothing sensitive in `ps` output.
6. **packages/cli stays offline.** Its README's "makes no network call,
   ever" is why `rankloop check` is trustworthy in CI. The runner is a
   separate package precisely so that sentence stays true.

## What the model returns is data, not obedience

The prompt ends with "return only the file", and models still wrap output
in code fences or lead with a sentence of chatter. `cleanDraft` strips
fences and cuts to the first `---` — recovering the file is cheaper than a
retry, and a retry over formatting teaches the user the runner is flaky.

## Configuration

`~/.config/rankloop/local.json` (the repo's existing creds directory), all
flags overriding:

    {
      "server": "http://localhost:5173",
      "projectId": "…",
      "write": { "command": "claude", "args": ["-p"], "timeoutMin": 10 },
      "repo": { "path": "~/mysite", "contentDir": "content/blog",
                "urlBase": "https://mysite.com/blog", "push": true },
      "outDir": "~/rankloop-drafts",
      "maxAttempts": 3,
      "allowSerpFetch": false
    }

Repo mode when `repo.path` is set; draft mode otherwise. Draft mode is the
Framer/Webflow answer: gated files pile up ready to paste.

## Acceptance

1. A machine with no API keys of any kind produces a law-passing draft
   using only the local CLI. (Verified live — see the E2E note in the
   package.)
2. An interrupted run never duplicates a generation, a file, or a report.
3. `publish_report` is never called for a URL that has not answered 200.
4. The runner refuses to overwrite files it did not write.
5. Zero runtime dependencies, same as packages/cli.
