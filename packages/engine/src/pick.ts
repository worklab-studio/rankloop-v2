/** THE POOL MIX RULE, ported from rankloop 0.2 brief.run_pick.
 *
 * When picking two or more slots and the fresh pool has a candidate,
 * exactly one slot comes from the pool. Score-ranked rows are metric-backed
 * bets; pool rows (harvested questions, glossary notes) are literal
 * questions real people asked, carrying neutral prior scores that would
 * otherwise never win a slot. One pool post per batch keeps the site
 * answering actual pain without letting unmeasured hunches take over the
 * calendar.
 *
 * The pool row replaces the LAST scored slot (the weakest bet gives way,
 * never the top pick), unless the scored picks came back short, in which
 * case the pool row simply fills the gap. If a pool-source row already
 * ranked into the scored picks on its own, the mix is satisfied and
 * nothing is swapped. */

export type Slot = "score" | "pool";

export function applyPoolMix<T extends { keyword: string }>(
  scored: T[],
  poolCandidates: T[],
  n: number,
): (T & { slot: Slot })[] {
  const rows: (T & { slot: Slot })[] = scored.map((r) => ({ ...r, slot: "score" as const }));
  if (n >= 2) {
    const have = new Set(rows.map((r) => r.keyword));
    const cand = poolCandidates.find((c) => !have.has(c.keyword));
    if (cand !== undefined) {
      const entry = { ...cand, slot: "pool" as const };
      if (rows.length >= n) rows[rows.length - 1] = entry;
      else rows.push(entry);
    }
  }
  return rows;
}
