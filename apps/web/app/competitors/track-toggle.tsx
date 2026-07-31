"use client";

/** Cosmetic tracked/ignored toggle per competitor card — local state only;
 * the real thing will PATCH the competitor row. */

import { useState } from "react";

export function TrackToggle({
  domain, initialTracked,
}: {
  domain: string; initialTracked: boolean;
}) {
  const [tracked, setTracked] = useState(initialTracked);
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2">
      <span className="text-xs text-base-content/50">
        {tracked ? "tracked" : "ignored"}
      </span>
      <input
        type="checkbox"
        className="toggle toggle-sm"
        checked={tracked}
        onChange={() => setTracked((v) => !v)}
        aria-label={`Track ${domain}`}
      />
    </label>
  );
}
