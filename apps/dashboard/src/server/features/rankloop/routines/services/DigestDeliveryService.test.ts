import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  callAt,
  jsonBodyOf,
  recordedCalls,
} from "@/server/features/rankloop/publish/adapters/fetchRecorder";
import type { FetchCall } from "@/server/features/rankloop/publish/adapters/fetchRecorder";
import { digestDeliveriesSchema } from "@/types/schemas/rankloopRoutines";
import type {
  DigestDelivery,
  DigestPayload,
} from "@/types/schemas/rankloopRoutines";

const mocks = vi.hoisted(() => ({
  repo: {
    getDeliveryOptIns: vi.fn(),
    getDigestRecipient: vi.fn(),
    recordDeliveries: vi.fn(),
  },
  email: {
    isDigestEmailConfigured: vi.fn(),
    sendRankloopDigestEmail: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/routines/repositories/DigestRepository",
  () => ({ DigestRepository: mocks.repo }),
);
vi.mock("@/server/email/loops", () => mocks.email);
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    $context: Promise.resolve({ secretConfig: "deploy-key" }),
  }),
}));

const NOW = new Date("2026-08-01T07:00:00.000Z");

const payload: DigestPayload = {
  forDate: "2026-08-01",
  headline: "1 shipped",
  awaiting: { total: 0, top: [] },
  shipped: [{ articleId: "art_1", title: "Best CRM for plumbers", url: null }],
  measured: [],
  blocked: [],
};

const fetchMock = vi.fn<typeof fetch>();

function sentRequest(index = 0): FetchCall {
  return callAt(recordedCalls(fetchMock.mock.calls), index);
}

async function deliver() {
  const { DigestDeliveryService } = await import("./DigestDeliveryService");
  return DigestDeliveryService.deliverDigest({
    projectId: "project_1",
    digestId: "dig_1",
    payload,
    now: NOW,
  });
}

const recordedWrite = z.object({
  digestId: z.string(),
  projectId: z.string(),
  deliveredJson: z.string(),
});

/** The delivery log as it was actually written, not as it was returned — the
 *  column is what every later screen reads. Parsed through the same schema
 *  `getRecentDigests` reads it back with, so a log the card could not render
 *  fails here instead of on someone's dashboard. */
function recordedLog(): DigestDelivery[] {
  const write = recordedWrite.parse(
    mocks.repo.recordDeliveries.mock.calls[0]?.[0],
  );
  return digestDeliveriesSchema.parse(JSON.parse(write.deliveredJson));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T07:00:00.000Z"));
  mocks.repo.getDeliveryOptIns.mockResolvedValue(null);
  mocks.repo.getDigestRecipient.mockResolvedValue("owner@acme.com");
  mocks.repo.recordDeliveries.mockResolvedValue(undefined);
  mocks.email.isDigestEmailConfigured.mockReturnValue(true);
  mocks.email.sendRankloopDigestEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("in-app delivery", () => {
  it("records the row itself as stored, on a project that configured nothing", async () => {
    const deliveries = await deliver();

    expect(deliveries).toEqual([
      {
        channel: "in_app",
        status: "stored",
        at: "2026-08-01T07:00:00.000Z",
        error: null,
      },
    ]);
    expect(recordedLog()).toEqual(deliveries);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.email.sendRankloopDigestEmail).not.toHaveBeenCalled();
  });

  it("still writes the log when the project opted out of both channels", async () => {
    mocks.repo.getDeliveryOptIns.mockResolvedValue({
      digestEmail: false,
      digestWebhookUrl: null,
    });

    expect(await deliver()).toHaveLength(1);
    expect(mocks.email.sendRankloopDigestEmail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("email delivery", () => {
  beforeEach(() => {
    mocks.repo.getDeliveryOptIns.mockResolvedValue({
      digestEmail: true,
      digestWebhookUrl: null,
    });
  });

  it("mails the organization's first member and records it sent", async () => {
    const deliveries = await deliver();

    expect(mocks.email.sendRankloopDigestEmail).toHaveBeenCalledWith({
      email: "owner@acme.com",
      dataVariables: {
        forDate: "2026-08-01",
        headline: "1 shipped",
        summary: "Shipped:\n- Best CRM for plumbers",
      },
    });
    expect(deliveries[1]).toMatchObject({ channel: "email", status: "sent" });
    expect(recordedLog()[1].status).toBe("sent");
  });

  it("records a rejected send instead of throwing it at the routine", async () => {
    mocks.email.sendRankloopDigestEmail.mockRejectedValue(
      new Error("Failed to send Loops transactional email (429)"),
    );

    const deliveries = await deliver();

    expect(deliveries[1]).toEqual({
      channel: "email",
      status: "failed",
      at: "2026-08-01T07:00:00.000Z",
      error: "Failed to send Loops transactional email (429)",
    });
    expect(recordedLog()[1].status).toBe("failed");
  });

  it("says so every morning when the deployment cannot send at all", async () => {
    mocks.email.isDigestEmailConfigured.mockReturnValue(false);

    expect((await deliver())[1]).toMatchObject({
      channel: "email",
      status: "failed",
      error: "this deployment has no Loops transactional path configured",
    });
    expect(mocks.email.sendRankloopDigestEmail).not.toHaveBeenCalled();
  });

  it("records the reason when there is nobody to mail", async () => {
    mocks.repo.getDigestRecipient.mockResolvedValue(null);

    expect((await deliver())[1]).toMatchObject({
      status: "failed",
      error: "the project's organization has no member to mail",
    });
  });
});

describe("webhook delivery", () => {
  beforeEach(() => {
    mocks.repo.getDeliveryOptIns.mockResolvedValue({
      digestEmail: false,
      digestWebhookUrl: "https://hooks.example.com/digest",
    });
  });

  it("sends one signed envelope whose signature verifies", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const deliveries = await deliver();

    const request = sentRequest();
    expect(request.url).toBe("https://hooks.example.com/digest");
    expect(request.method).toBe("POST");
    expect(request.headers["x-rankloop-event"]).toBe("digest.daily");
    expect(jsonBodyOf(request)).toMatchObject({
      event: "digest.daily",
      projectId: "project_1",
      forDate: "2026-08-01",
    });

    // The receiver's own check, done the receiver's way: HMAC over
    // `timestamp.body` with the project's derived secret.
    const secret = `sha256=${createHmac("sha256", "deploy-key")
      .update("rankloop:digest.project_1")
      .digest("hex")}`;
    const expected = `sha256=${createHmac("sha256", secret)
      .update(
        `${request.headers["x-rankloop-timestamp"]}.${request.body ?? ""}`,
      )
      .digest("hex")}`;
    expect(request.headers["x-rankloop-signature"]).toBe(expected);

    expect(deliveries[1]).toMatchObject({ channel: "webhook", status: "sent" });
  });

  it("signs with a secret that is project-scoped, so one receiver cannot verify another's digest", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { DigestDeliveryService } = await import("./DigestDeliveryService");

    await deliver();
    await DigestDeliveryService.deliverDigest({
      projectId: "project_2",
      digestId: "dig_2",
      payload,
      now: NOW,
    });

    expect(sentRequest(0).headers["x-rankloop-signature"]).not.toBe(
      sentRequest(1).headers["x-rankloop-signature"],
    );
  });

  it("records the status code when the endpoint says no", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    expect((await deliver())[1]).toEqual({
      channel: "webhook",
      status: "failed",
      at: "2026-08-01T07:00:00.000Z",
      error: "the endpoint returned 500",
    });
    expect(recordedLog()[1].status).toBe("failed");
  });

  it("records an unreachable endpoint rather than throwing it at the routine", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network connection lost."));

    await expect(deliver()).resolves.toHaveLength(2);
    expect(recordedLog()[1]).toMatchObject({
      channel: "webhook",
      status: "failed",
      error: "Network connection lost.",
    });
  });

  it("refuses a stored URL that is not http(s) instead of fetching it", async () => {
    mocks.repo.getDeliveryOptIns.mockResolvedValue({
      digestEmail: false,
      digestWebhookUrl: "file:///etc/passwd",
    });

    expect((await deliver())[1]).toMatchObject({
      status: "failed",
      error: "the webhook URL must be http or https",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("when storage itself fails", () => {
  it("still returns what happened rather than failing the routine", async () => {
    mocks.repo.getDeliveryOptIns.mockRejectedValue(new Error("D1_ERROR"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(deliver()).resolves.toEqual([
      {
        channel: "in_app",
        status: "stored",
        at: "2026-08-01T07:00:00.000Z",
        error: null,
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });
});
