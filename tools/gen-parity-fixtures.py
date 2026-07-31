#!/usr/bin/env python3
"""Generate parity fixtures for @rankloop/engine by running the REAL
rankloop 0.2 (the Python reference implementation) and recording its
outputs. The TypeScript engine's tests assert byte-for-byte agreement.

    RANKLOOP_PATH=/path/to/rankloop /opt/homebrew/bin/python3.14 tools/gen-parity-fixtures.py

Regenerate whenever the port's behavior is deliberately changed, in the
same commit. Requires Python 3.11+ and a checkout of
github.com/worklab-studio/rankloop (defaults to /Users/worklab/Rankloop).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

RANKLOOP = os.environ.get("RANKLOOP_PATH", "/Users/worklab/Rankloop")
sys.path.insert(0, RANKLOOP)

from rankloop import config as rc  # noqa: E402
from rankloop import store as rs  # noqa: E402
from rankloop import laws as rl  # noqa: E402
from rankloop import brief as rb  # noqa: E402
from rankloop import wire as rw  # noqa: E402
from rankloop import routines as rr  # noqa: E402
from rankloop.discover import classify, relevant, score  # noqa: E402
from rankloop.brief import slugify  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "packages/engine/test/fixtures/parity.json"
TODAY = dt.date(2026, 7, 30)

# --- the demo site (same fictional corpus as the rankloop smoke tests) ---

CONFIG_MD = """\
[site]
url = "https://demo.example"
name = "Demo"
description = "A demo site about home espresso."
site_dir = "website"
blog_path = "blog"
mode = "markdown"

[taxonomy]
categories = { Guides = "guides", Compare = "compare" }

[keywords]
positive = ["\\\\b(espresso|coffee|grinder|portafilter)\\\\b"]
negative = ["\\\\b(casino|crypto)\\\\b"]

[laws]
word_min = 40
h2_min = 2
faq_min = 1
internal_links_min = 0
use_vale = false
use_lychee = false
"""

CONFIG_HTML = CONFIG_MD.replace('mode = "markdown"', 'mode = "html"')

GOOD_POST = """\
---
title: How I Dial In Espresso in Five Shots
description: The exact routine I use to dial in a new bag of espresso beans.
date: 2026-07-20
category: Guides
keyword: dial in
---
I dial in a new bag the same way every time, and it rarely takes more than
five shots from the first coarse pull to a balanced cup I am happy with.

## Start coarse and fast

My first shot is always deliberately coarse. I taste it, note the sourness,
and tighten the grind one step at a time until the shot slows down.

## What changes shot to shot

Each shot moves exactly one variable. I never change the dose and the grind
together, because then I cannot tell which change fixed the cup.

## Is five shots really enough?

Yes, for most beans. I keep the last bag's setting written on the bag clip,
so the next bag starts close and the routine converges quickly.
"""

BAD_POST = """\
---
title: A Post That Breaks the Laws On Purpose Because It Is Far Far Too Long a Title
description: short.
date: 2026-07-21
category: Guides
---
Too short. In today's fast-paced world, one paragraph and a banned phrase.
"""

COMPARE_POST = """\
---
title: Flat vs Conical Burrs for Espresso
description: What actually changes in the cup between flat and conical burr grinders.
date: 2026-07-22
category: Compare
keyword: flat vs conical burrs
---
I have pulled shots on both flat and conical burr grinders for years, and
the flat vs conical burrs debate matters less than alignment and grind
retention in my testing.

## What flat burrs change

Flat burrs give me a tighter particle distribution and a cleaner,
higher-clarity cup. They also heat up faster on long dialing sessions.

## What conical burrs change

Conical burrs run quieter, retain less, and forgive a sloppy distribution
technique more than any flat set I have owned.

## Is one of them simply better?

No. For milk drinks I reach for the conical; for straight shots of a washed
single origin, the flat set wins the taste test at my bar more often than
not. See [my dial-in routine](/blog/dialing-in-espresso/) for the workflow
either way.
"""

HTML_POST = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>My Espresso Grinder Cleaning Routine</title>
<link rel="canonical" href="https://demo.example/blog/grinder-cleaning/">
<meta name="keywords" content="grinder cleaning, espresso maintenance">
<meta name="description" content="How I clean my espresso grinder.">
<script type="application/ld+json">{"@context": "https://schema.org", "@graph": [{"@type": "BlogPosting", "headline": "My Espresso Grinder Cleaning Routine", "description": "How I clean my espresso grinder, and how often it actually needs it.", "datePublished": "2026-07-22", "articleSection": "Guides", "timeRequired": "PT4M", "author": {"@type": "Person", "name": "Demo"}}]}</script>
</head>
<body>
<main>
<article>
<p>I clean my espresso grinder on the first Sunday of every month, and my grinder cleaning routine takes about ten minutes from start to finish once the beans are out.</p>
<h2>What I remove &amp; what I leave</h2>
<p>I take out the hopper and the upper burr, brush the chamber, and vacuum the chute. I leave the lower burr seated because pulling it shifts the alignment I calibrated.</p>
<h2>How often is too often?</h2>
<p>For a home machine, monthly is plenty in my testing. Oily beans move that to every two weeks; a shop should do it weekly.</p>
<div class="faq-item"><h3>Do cleaning tablets work?</h3><p>They work for the chute and the burr faces, but I still brush the corners the tablets never reach.</p></div>
<p>The one internal page I point people at first is <a href="/blog/dialing-in-espresso/">my dial-in routine</a>, because a clean grinder drifts your setting.</p>
</article>
</main>
</body>
</html>
"""


def make_site(tmp: str, config: str, files: dict[str, str]) -> rc.Config:
    root = Path(tmp)
    (root / "website/blog").mkdir(parents=True, exist_ok=True)
    (root / "rankloop.toml").write_text(config)
    for rel, content in files.items():
        p = root / "website/blog" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return rc.load(root / "rankloop.toml")


def cfg_json(cfg: rc.Config) -> dict:
    """Emit exactly the TS EngineConfig shape."""
    return {
        "site": {
            "url": cfg.site.url,
            "name": cfg.site.name,
            "description": cfg.site.description,
            "blogPath": cfg.site.blog_path,
            "mode": cfg.site.mode,
        },
        "taxonomy": dict(cfg.taxonomy.categories),
        "keywords": {
            "positive": list(cfg.keywords.positive),
            "negative": list(cfg.keywords.negative),
            "classify": list(cfg.keywords.classify),
        },
        "laws": {
            "wordMin": cfg.laws.word_min,
            "wordMax": cfg.laws.word_max,
            "h2Min": cfg.laws.h2_min,
            "faqMin": cfg.laws.faq_min,
            "internalLinksMin": cfg.laws.internal_links_min,
            "titleMax": cfg.laws.title_max,
            "descriptionMax": cfg.laws.description_max,
            "keywordDensityMax": cfg.laws.keyword_density_max,
            "banEmDash": cfg.laws.ban_em_dash,
            "requireFirstPerson": cfg.laws.require_first_person,
            "bannedPhrases": list(cfg.laws.banned_phrases),
        },
    }


def problems_json(problems) -> list[list[str]]:
    return [[slug, name] for slug, name in problems]


def main() -> None:
    fx: dict = {
        "meta": {
            "generator": "tools/gen-parity-fixtures.py",
            "rankloopPath": RANKLOOP,
            "python": sys.version.split()[0],
            "today": TODAY.isoformat(),
        }
    }

    # --- scoring grid ---
    volumes = [None, 0, 10, 880, 5400, 100000]
    difficulties = [None, 0, 15, 30, 50, 85, 100]
    intents = [None, "commercial", "transactional", "informational", "navigational", "unknown-intent"]
    fx["score"] = [
        {"volume": v, "difficulty": d, "intent": i, "expected": score(v, d, i)}
        for v in volumes for d in difficulties for i in intents
    ]

    fx["slugify"] = [
        {"input": s, "expected": slugify(s)}
        for s in [
            "Best Espresso Grinder!!",
            "  How to -- Dial In  ",
            "Café crème & milk",
            "why is my espresso sour?",
            "a" * 80,
            "-- already -- dashed --",
            "best espresso grinder",
        ]
    ]

    classify_kws = [
        "best espresso grinder", "breville vs gaggia", "lelit alternative",
        "espresso machine review", "is a grinder worth it", "portafilter size chart",
        "espresso not working", "how to dial in espresso", "what is crema",
        "why is my espresso sour", "grinder burr replacement", "top espresso recipes",
        "does tamping pressure matter", "using a grinder instead of blade",
        "coffee tastes sour fix",
    ]
    relevant_kws = [
        "best espresso grinder", "espresso casino night", "crypto coffee token",
        "how to clean a coffee grinder", "best knife sharpener", "portafilter size guide",
        "grinder for spices",
    ]
    classify_rules = [
        {"pattern": "\\bvs\\b", "category": "Compare", "format": "comparison"},
        {"pattern": "sour"},
        {"pattern": "what is", "category": "Guides", "format": "explainer"},
    ]

    with tempfile.TemporaryDirectory() as t:
        cfg = make_site(t, CONFIG_MD, {"dialing-in-espresso.md": GOOD_POST})
        fx["configMd"] = cfg_json(cfg)
        fx["classify"] = {
            "base": [
                {"kw": k, "category": classify(cfg, k)[0], "format": classify(cfg, k)[1]}
                for k in classify_kws
            ]
        }
        fx["relevant"] = [{"kw": k, "ok": relevant(cfg, k)} for k in relevant_kws]
        cfg.keywords.classify = classify_rules
        fx["classify"]["withRules"] = {
            "rules": classify_rules,
            "cases": [
                {"kw": k, "category": classify(cfg, k)[0], "format": classify(cfg, k)[1]}
                for k in classify_kws
            ],
        }
        cfg.keywords.classify = []
        # laws: green corpus
        posts = rl.manifest(cfg)
        fx["laws"] = {"good": problems_json(rl._validate(cfg, posts))}

    # --- laws: failing corpus ---
    with tempfile.TemporaryDirectory() as t:
        cfg = make_site(t, CONFIG_MD, {
            "dialing-in-espresso.md": GOOD_POST,
            "bad-post.md": BAD_POST,
        })
        posts = rl.manifest(cfg)
        fx["laws"]["fail"] = problems_json(rl._validate(cfg, posts))

    # --- wire + brief corpus (two categories) ---
    with tempfile.TemporaryDirectory() as t:
        cfg = make_site(t, CONFIG_MD, {
            "dialing-in-espresso.md": GOOD_POST,
            "flat-vs-conical-burrs.md": COMPARE_POST,
        })
        posts = sorted(rl.manifest(cfg), key=lambda p: p.date or "", reverse=True)
        fx["wire"] = {
            "sitemap": rw._sitemap(cfg, posts),
            "rss": rw._rss(cfg, posts),
            "llmsTxt": rw._llms_txt(cfg, posts),
            "llmsFull": rw._llms_full(cfg, posts),
        }

        db = rs.get_db(Path(t) / "rankloop.sqlite")
        kw = "best espresso grinder"
        rs.upsert_keyword(
            db, kw, category="Compare", format="comparison", search_volume=5400,
            keyword_difficulty=30, intent="commercial", score=5.2, source="dataforseo",
        )
        organic = [
            {"url": "https://a.example/1", "title": "The 9 Best Espresso Grinders of 2026", "description": "x"},
            {"url": "https://b.example/2", "title": "Best Espresso Grinders, Tested by Baristas", "description": "y"},
            {"url": "https://c.example/3", "title": "Espresso Grinder Buying Guide", "description": "z"},
        ]
        paa = [
            "how much should i spend on an espresso grinder",
            {"question": "do i need a single dose grinder"},
            "are flat burrs better than conical",
        ]
        db.execute(
            "INSERT INTO serp_data (keyword, organic_json, paa_json) VALUES (?,?,?)",
            (kw, json.dumps(organic), json.dumps(paa)),
        )
        db.commit()
        row = db.execute("SELECT * FROM keywords WHERE keyword=?", (kw,)).fetchone()

        class _FixedDate(dt.date):
            @classmethod
            def today(cls):
                return dt.date(2026, 7, 30)

        orig_date = rb.dt.date
        rb.dt.date = _FixedDate
        try:
            markdown = rb._brief_markdown(cfg, db, row, "Compare", posts)
        finally:
            rb.dt.date = orig_date
        db.close()

        fx["brief"] = {
            "today": TODAY.isoformat(),
            "category": "Compare",
            "row": {
                "keyword": row["keyword"],
                "category": row["category"],
                "format": row["format"],
                "searchVolume": row["search_volume"],
                "keywordDifficulty": row["keyword_difficulty"],
                "intent": row["intent"],
                "score": row["score"],
                "source": row["source"],
                "notes": row["notes"],
            },
            "serp": {"organic": organic, "paa": paa},
            "markdown": markdown,
        }
        # no-serp variant exercises the fallback line
        rb.dt.date = _FixedDate
        try:
            fx["brief"]["markdownNoSerp"] = rb._brief_markdown(
                cfg, db_none := rs.get_db(Path(t) / "empty.sqlite"), row, "Compare", posts)
        finally:
            rb.dt.date = orig_date
            db_none.close()

    # --- html corpus: parse + laws + llms-full ---
    with tempfile.TemporaryDirectory() as t:
        cfg = make_site(t, CONFIG_HTML, {"grinder-cleaning/index.html": HTML_POST})
        posts = rl.manifest(cfg)
        p = posts[0]
        fx["laws"]["html"] = problems_json(rl._validate(cfg, posts))
        fx["htmlPost"] = {
            "slug": p.slug, "title": p.title, "description": p.description,
            "date": p.date, "category": p.category, "wordCount": p.word_count,
            "keyword": p.keyword, "minutes": p.minutes,
        }
        fx["wire"]["htmlLlmsFull"] = rw._llms_full(cfg, posts)
        fx["configHtml"] = cfg_json(cfg)

    # --- quota (catch-up semantics) ---
    quota_cases = []

    def quota_case(start: str, ppd: int, cap: int, files: dict[str, str]):
        with tempfile.TemporaryDirectory() as t:
            cfg = make_site(t, CONFIG_MD, files)
            cfg.writer.start_date = start
            cfg.writer.posts_per_day = ppd
            cfg.writer.catchup_cap = cap
            published = [p.date for p in rl.manifest(cfg)]
            quota_cases.append({
                "startDate": start, "postsPerDay": ppd, "catchupCap": cap,
                "publishedDates": published, "today": TODAY.isoformat(),
                "expected": rr.compute_quota(cfg, today=TODAY),
            })

    good = {"dialing-in-espresso.md": GOOD_POST}
    quota_case("", 2, 6, good)                       # not configured -> None
    quota_case("not-a-date", 2, 6, good)             # unparseable -> None
    quota_case("2026-07-21", 2, 6, good)             # 10 days x2, 0 published -> cap 6
    quota_case("2026-07-20", 2, 6, good)             # 11 days x2, 1 published -> cap 6
    quota_case("2026-07-29", 1, 6, good)             # 2 days x1, 0 published -> 2
    quota_case("2026-08-05", 2, 6, good)             # future start -> 0
    quota_case("2026-07-30", 2, 6, {
        "dialing-in-espresso.md": GOOD_POST.replace("date: 2026-07-20", "date: 2026-07-30"),
    })                                               # today x2, 1 published today -> 1

    fx["quota"] = quota_cases

    # --- the raw corpora, so the TS tests parse the same inputs ---
    fx["corpora"] = {
        "good": {"mode": "markdown", "files": {"dialing-in-espresso.md": GOOD_POST}},
        "fail": {"mode": "markdown", "files": {
            "dialing-in-espresso.md": GOOD_POST, "bad-post.md": BAD_POST}},
        "wire": {"mode": "markdown", "files": {
            "dialing-in-espresso.md": GOOD_POST, "flat-vs-conical-burrs.md": COMPARE_POST}},
        "html": {"mode": "html", "files": {"grinder-cleaning/index.html": HTML_POST}},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024}KB)")
    print(f"  score cases:    {len(fx['score'])}")
    print(f"  classify cases: {len(fx['classify']['base']) + len(fx['classify']['withRules']['cases'])}")
    print(f"  laws fail rows: {len(fx['laws']['fail'])}")
    print(f"  quota cases:    {len(fx['quota'])}")


if __name__ == "__main__":
    main()
