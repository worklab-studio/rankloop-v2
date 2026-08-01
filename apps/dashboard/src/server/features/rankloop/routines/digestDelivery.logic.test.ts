import { describe, expect, it } from "vitest";
import type { DigestPayload } from "@/types/schemas/rankloopRoutines";
import {
  digestEmailVariables,
  digestEnvelope,
  digestSummaryText,
} from "./digestDelivery.logic";

function payload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    forDate: "2026-08-01",
    headline: "1 shipped, 1 waiting on you",
    awaiting: { total: 0, top: [] },
    shipped: [],
    measured: [],
    blocked: [],
    ...overrides,
  };
}

describe("digestEnvelope", () => {
  it("carries the stored payload verbatim under the daily event", () => {
    const stored = payload({ headline: "2 things blocked" });

    expect(digestEnvelope({ projectId: "project_1", payload: stored })).toEqual(
      {
        event: "digest.daily",
        projectId: "project_1",
        forDate: "2026-08-01",
        payload: stored,
      },
    );
  });
});

describe("digestSummaryText", () => {
  it("omits the sections that had no news rather than printing empty headings", () => {
    const text = digestSummaryText(
      payload({
        shipped: [
          {
            articleId: "art_1",
            title: "Best CRM for plumbers",
            url: "https://acme.com/best-crm-for-plumbers/",
          },
        ],
      }),
    );

    expect(text).toBe(
      "Shipped:\n- Best CRM for plumbers — https://acme.com/best-crm-for-plumbers/",
    );
  });

  it("says how many proposals it did not list, so a queue of forty is not read as five", () => {
    const text = digestSummaryText(
      payload({
        awaiting: {
          total: 40,
          top: [
            {
              id: "prop_1",
              type: "retitle",
              target: "/pricing/",
              title: "Pricing",
              score: 8.2,
              evidence: ["ranks 11th for its own headline query"],
            },
          ],
        },
      }),
    );

    expect(text).toBe(
      [
        "Waiting on you (40):",
        "- retitle /pricing/ — score 8.2",
        "- …and 39 more",
      ].join("\n"),
    );
  });

  it("leaves out a link the adapter could not confirm", () => {
    const text = digestSummaryText(
      payload({
        shipped: [{ articleId: "art_1", title: "Cheapest CRM", url: null }],
      }),
    );

    expect(text).toBe("Shipped:\n- Cheapest CRM");
  });

  it("signs a receipt's delta and spells out the one it could not measure", () => {
    const text = digestSummaryText(
      payload({
        measured: [
          {
            receiptId: "rec_1",
            actionType: "retitle",
            target: "/crm-for-plumbers/",
            verdict: "win",
            adjustedClicksDelta: 39.72,
            positionDelta: 3.3,
          },
          {
            receiptId: "rec_2",
            actionType: "push",
            target: "crm for plumbers",
            verdict: "no_change",
            adjustedClicksDelta: null,
            positionDelta: null,
          },
        ],
      }),
    );

    expect(text).toBe(
      [
        "Measured:",
        "- win: /crm-for-plumbers/ (+39.7 clicks)",
        "- no change: crm for plumbers (no clicks to compare)",
      ].join("\n"),
    );
  });
});

describe("digestEmailVariables", () => {
  it("is the three fields a template is written against and no more", () => {
    const variables = digestEmailVariables(
      payload({ blocked: [{ kind: "throttle", detail: "quota held at 1" }] }),
    );

    expect(Object.keys(variables).toSorted()).toEqual([
      "forDate",
      "headline",
      "summary",
    ]);
    expect(variables.summary).toBe("Blocked:\n- quota held at 1");
  });
});
