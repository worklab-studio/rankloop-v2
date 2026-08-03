# rankloop-local

rankloop's writing loop on your own machine. Your CLI writes (`claude -p`
by default), the server's publish laws grade, and a cron keeps it moving.

**No API keys.** The writer is whatever CLI you already pay for, and a
localhost dashboard (`AUTH_MODE=local_noauth`) needs no token. The marginal
cost of an article is zero.

```
rankloop dashboard (workerd)          your laptop (node)
  rankloop_status      ◄──────────────  rankloop-local run
  rankloop_proposals   ◄──────────────    │ approved & unwritten
  rankloop_brief       ◄──────────────    │ the grounded prompt
                                          │ spawns `claude -p` ── writes
  rankloop_check       ◄──────────────    │ the 15 laws grade it
                        violations ───►   │ re-prompt, ≤3 attempts
  rankloop_publish_report ◄───────────    │ after the URL is live
```

The dashboard cannot do this itself: it runs on workerd, which has no
`child_process`. This package is the one place a process gets spawned, and
it is the user's own process on the user's own machine.

## Quick start

```bash
# 1. dashboard running locally, a project with approved titles,
#    Connect → Writing set to "agent"
# 2.
rankloop-local run --project <id-from-the-dashboard-url>
```

Gated drafts land in `~/rankloop-drafts/`. To publish automatically, add a
repo to `~/.config/rankloop/local.json`:

```json
{
  "projectId": "…",
  "write": { "command": "claude", "args": ["-p"] },
  "repo": {
    "path": "~/mysite",
    "contentDir": "content/blog",
    "urlBase": "https://mysite.com/blog",
    "push": true
  }
}
```

With a repo configured the runner writes the markdown, commits, pushes,
**waits until the URL answers 200**, and only then reports it — which is
what opens the receipt. `rankloop-local cron` prints the crontab and
launchd lines.

## The rules it keeps

- Reports only what it observed live. A slow deploy stops the run at
  `pushed`; the next run resumes at verification, not at writing.
- Never generates the same article twice — a state file
  (`~/.config/rankloop/local-state.json`) survives crashes and lid-closes.
- Never overwrites a file it did not write.
- The grader is never the author, now as separate processes: your CLI
  writes, the server's engine grades, and publishing re-runs the same check.

## Verified

The acceptance run on 2026-08-03, against a live dashboard with no API
keys configured: `claude -p` wrote "Best grind size for espresso" — attempt
one failed 2 laws, the violations went back as data, attempt two passed all
15 — 1,638 words, 7 H2 sections, 4 FAQ entries, zero em dashes, first
person as voice with no claimed experience. Total spend: $0.00.
