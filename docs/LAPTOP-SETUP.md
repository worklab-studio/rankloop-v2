# rankloop on your laptop, with your own repo

For this setup, which is the common one:

    your website source on your laptop
      → you edit it (in Claude Code or anything else)
      → git push
      → GitHub → Cloudflare → live on your domain

rankloop slots into it without changing any of it. It writes a markdown
file into your repo, commits, pushes, and waits until the page is live
before recording anything. Your existing deploy does the deploying.

**No API keys.** Your own `claude` CLI writes the posts, so the marginal
cost of an article is zero.

---

## The two pieces, and why there are two

**The dashboard** decides *what* to write: it studies your site, finds
competitors, builds the keyword universe, plans page types, and grades
every draft against the publish laws. It runs on Cloudflare's runtime,
which cannot start other programs — so it can never call your CLI itself.

**`rankloop-local`** is the piece that can. It sits on your laptop, asks
the dashboard what is owed, spawns your CLI to write it, sends the draft
back to be graded, and pushes it when it passes.

Both run locally. The dashboard needs to be running while the runner
works, the same way a database does.

---

## Setup

### 1. Start the dashboard, once

```bash
cd rankloop-v2/apps/dashboard
npm run dev            # leave this running
```

Open http://localhost:5173, add your domain. It starts studying the site
by itself.

### 2. Set it up from inside your website repo

```bash
cd ~/path/to/your-website
rankloop-local init
```

It reads your repo and fills in the answers: your framework, your domain
(from your CNAME, `wrangler.toml` route, or `package.json`), and where
posts should go. Press enter through anything already correct.

It writes `~/.config/rankloop/local.json` and prints what to do next.

### 3. Find out what is still blocking

```bash
rankloop-local doctor
```

This is the command to run whenever nothing seems to happen. It checks
every layer and names **the first one that is shut**, not the last:

```
  ✓ Config           ~/.config/rankloop/local.json → project 5c27477e…
  ✓ Writer CLI       `claude` found
  ✓ Your repo        found — posts will be committed and pushed
  ✓ Dashboard        http://localhost:5173
  ✗ Writer mode      "api" — the dashboard's own writer owns this project
  ! Quota            quota off — propose manually
  ✗ Approved titles  no titles approved yet

Next: Writer mode: Set it to agent in Connect → Writing.
```

`✗` blocks. `!` is a choice you have made, not a fault.

### 4. Run it

```bash
rankloop-local run                      # one proposal
rankloop-local run --watch --every 30m  # keep going
rankloop-local cron                     # the crontab / launchd lines
```

---

## What a run does, in your repo

```
asks the dashboard what is approved and unwritten
fetches the brief   (SERP grounding, your voice, the laws it will be graded on)
spawns `claude -p`  with the brief on stdin
grades the draft    against the 15 publish laws — free, no model
  fails? the violations go back as data → rewrite → grade again (≤3)
  passes?
    writes content/blog/<slug>.md into your repo
    git add, git commit, git push
    polls https://yourdomain.com/blog/<slug>/ until it answers 200
    only then records it, which opens the receipt that measures it
```

That last order matters. A receipt is a claim that a page went live; the
runner will not make that claim about a URL it has not seen. If your
deploy is slow it stops after the push and the next run finishes the job —
it never regenerates the article.

---

## Before anything can be written

rankloop refuses to write about nothing, so a new project needs these in
order. `doctor` tells you which one you are on.

1. **Site studied** — automatic once the domain is set.
2. **Keywords** — Plan → gather. Free sources work; DataForSEO gives more.
3. **A page type approved** — Plan → Gate 1. This is what tells rankloop
   what *kind* of pages to write.
4. **Titles approved** — Publish → Gate 2. The daily quota proposes them,
   or you propose them yourself.
5. **Writer mode: agent** — Connect → Writing. Otherwise the dashboard's
   own writer owns the project and the runner correctly stays out of it.

---

## Where things live

| | |
|---|---|
| Config | `~/.config/rankloop/local.json` |
| What it has already done | `~/.config/rankloop/local-state.json` |
| Drafts (when no repo is set) | `~/rankloop-drafts/` |
| Posts (repo mode) | `<your repo>/content/blog/` |

`content/blog/` is where the GitHub adapter writes and where the scaffolded
blog reads from, so the runner, the publisher and your site all agree
without any of them configuring the others.

If your repo has no blog yet, Connect → Design will open a pull request
that adds one — an index page, a post page, and a stylesheet built from
your own site's colours and fonts.
