import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import { tagChipClass, tagDotClass } from "@/shared/tag-colors";

// Chip anatomy mirrors TagChip's xs size (h-5 px-1.5 text-[11px]) so the
// type, page-type and evidence chips read as the same system as saved-keyword
// tags.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium";

export function TypeChip({ type }: { type: string }) {
  const display = proposalTypeDisplay(type);
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${tagDotClass(display.color)}`}
      />
      {display.label}
    </span>
  );
}

/** The approved page type a net-new row was written against. Violet is the
 *  page plan's own pSEO colour, so the chip carries the plan tab's vocabulary
 *  onto the queue instead of inventing a second one. */
export function PageTypeChip({ name }: { name: string }) {
  return (
    <span
      title={`Written against the "${name}" page type`}
      className={`${chipBaseClass} ${tagChipClass("violet")}`}
    >
      {name}
    </span>
  );
}

/** The pool slot, made visible. One row per batch comes from harvested
 *  questions rather than the score ranking, and that is a decision about the
 *  user's calendar — the title explains the rule where the chip appears
 *  rather than leaving it to the docs. */
export function FreshQuestionChip() {
  return (
    <span
      title="One slot in every batch goes to a question real people asked, so the site keeps answering pain the metrics can't see."
      className={`${chipBaseClass} cursor-help ${tagChipClass("lime")}`}
    >
      fresh question
    </span>
  );
}

export function EvidenceChip({ label }: { label: string }) {
  return (
    <span className={`${chipBaseClass} ${tagChipClass("slate")}`}>{label}</span>
  );
}
