"use client";

/** Per-status pipeline actions. Cosmetic in M2 — clicking queues nothing,
 * it just confirms optimistically via toast. Kept as a small client island
 * so the detail page stays a server component. */

import { useState } from "react";
import { CardShell } from "@/components/ui";
import type { ArticleStatus } from "@/lib/types";

export function ArticleActions({
  status,
  attempts,
}: {
  status: ArticleStatus;
  attempts: number;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // writing has nothing to click yet; published articles just measure.
  if (status === "writing" || status === "published") return null;

  const fire = (msg: string) => {
    setDone(true);
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  };

  return (
    <>
      <CardShell title="Actions" stamp="demo shell — actions go live with the API in M3.">
        <div className="flex flex-col gap-2">
          {status === "review" ? (
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={done}
                onClick={() => fire("approved — handing off to the publish adapter")}
              >
                {done ? "queued for publish" : "Approve & publish"}
              </button>
              <div className="tooltip w-full" data-tip="editor ships in M3">
                <button className="btn btn-sm w-full" disabled>
                  Edit draft
                </button>
              </div>
            </>
          ) : null}

          {status === "gate" ? (
            <button
              className="btn btn-primary btn-sm"
              disabled={done}
              onClick={() => fire(`fix loop queued — attempt ${attempts + 1}`)}
            >
              {done ? "fix loop queued" : "Retry fix loop"}
            </button>
          ) : null}

          {status === "failed" ? (
            <button
              className="btn btn-sm"
              disabled={done}
              onClick={() => fire("moved to review — human eyes decide now")}
            >
              {done ? "sent to review" : "Send to review"}
            </button>
          ) : null}
        </div>
      </CardShell>

      {toast ? (
        <div className="toast toast-end z-50">
          <div className="alert alert-success shadow-lg">
            <span className="text-sm">{toast}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
