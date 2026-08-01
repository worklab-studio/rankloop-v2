# rankloop

**The publish laws, offline.** Scaffold a repo for agent writing, then run the
rankloop quality laws over its content tree as a status check. This package
makes no network call, ever: the engine is MIT and the laws are pure functions,
so the gate works in any repo, with or without a rankloop account.

```sh
rankloop init      # scaffold rankloop.json, the writer prompt, the post
                   # template and a CI workflow; never overwrites
rankloop check     # run the laws over the content tree; exit 1 on a failure
rankloop brief KW  # the writer brief from local config and content
```

## Not on npm yet

`rankloop` is **not published**. Until it is, install from the repo:

```sh
git clone https://github.com/worklab-studio/rankloop-v2
cd rankloop-v2 && pnpm install && pnpm --filter rankloop build
node packages/cli/dist/rankloop.js check --dir /path/to/your/site
```

`init` scaffolds `.github/workflows/rankloop-check.yml` with its check step
**commented out** for the same reason, and prints a notice in the job so nobody
mistakes a green tick for an enforced gate. A CI gate that fails on the first
pull request of a fresh repo is one people learn to click past, which costs
more than the week of not having it. Uncomment the step once the package ships.

## After `rankloop init`

Four files land, and none of them is ever overwritten on a re-run:

    rankloop.json                            the whole site in one file
    rankloop/writer-prompt.md                the voice and the honesty contract
    rankloop/post-template.md                the shape a post follows
    .github/workflows/rankloop-check.yml     the laws as a merge gate

**Check `site.blogPath` first.** The framework, the content directory and the
markdown/html mode are all read off your repo, so they are usually right.
`blogPath` — the URL prefix your posts are served under — is the one value with
nothing on disk to confirm it: it is taken from the content directory's name
when that name looks like a URL segment (`posts`, `blog`, `articles`, …) and
falls back to `blog` otherwise. Every internal link a brief hands a writer is
built from it, so a wrong prefix means a post full of URLs that 404.

Then set `site.url`, edit the taxonomy to your own hubs, and write the voice
block in `rankloop/writer-prompt.md` — the scaffolded one is a placeholder with
an `EDIT ME` marker, not a voice.

## The laws

`check` reads `rankloop.json`, walks `contentDir`, and reports every violation
as `path:line: law`, the shape every compiler has used since cc. `--format=github`
emits workflow annotations instead, so a failure lands on the offending line of
the diff rather than in the log tail. The thresholds live in the config's `laws`
block; delete any one of them to inherit the engine's default.

## The offline brief

`rankloop brief "espresso grinder"` renders the same brief the dashboard does,
fed only from what is on disk: the laws with their exact thresholds, the
taxonomy, the banned phrases and the real internal-link candidates. There is no
SERP section, no volume and no difficulty, and it says so rather than printing
`-` and letting a writer assume the data was checked. Dates are UTC, so the
brief agrees with the laws and the dashboard about what day it is.

Pipe it into whatever writes your posts. `check` decides whether it ships.

MIT.
