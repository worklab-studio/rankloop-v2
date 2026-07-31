import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import {
  hasWriterProvider,
  resolveWriterModelId,
} from "@/server/features/rankloop/writing/draft";
import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { ArticleGateService } from "@/server/features/rankloop/writing/services/ArticleGateService";
import { ArticleWriteService } from "@/server/features/rankloop/writing/services/ArticleWriteService";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  MAX_WRITE_ATTEMPTS,
  WRITE_ATTEMPT_COST_ESTIMATE_USD,
} from "@/shared/rankloop-writer";
import {
  getRankloopArticleSchema,
  getRankloopArticlesSchema,
  parseLawReport,
  recheckRankloopArticleSchema,
  writeRankloopArticleSchema,
} from "@/types/schemas/rankloopWriter";

// The writer's transport layer. Exactly one endpoint here can cost money, and
// it costs it asynchronously: `write` hands the article to a workflow and
// returns. `recheck` deliberately reaches the gate and never the generator —
// editing a sentence by hand is free, and that is what keeps the `drafts` dial
// usable.

const projectScopedSchema = z.object({ projectId: z.string().uuid() });

/**
 * Whether this deployment can write, what it would write with, and what that
 * would cost.
 *
 * Read before anything renders, so a keyless deployment shows the setup pitch
 * where the Write button would be instead of offering a button that throws —
 * and so the confirm modal can state the ceiling in the same click the user is
 * deciding about.
 */
export const getRankloopWriterAccess = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const settings = await WriterSettingsRepository.getSettings(
      context.projectId,
    );
    return {
      providerConfigured: await hasWriterProvider(),
      model: await resolveWriterModelId(settings?.model ?? null),
      estimatedAttemptCostUsd: WRITE_ATTEMPT_COST_ESTIMATE_USD,
      maxAttempts: MAX_WRITE_ATTEMPTS,
    };
  });

export const writeRankloopArticle = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(writeRankloopArticleSchema)
  .handler(async ({ context, data }) => {
    const result = await ArticleWriteService.startArticle({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_writer:article_start",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          article_id: result.articleId,
          already_writing: result.alreadyWriting,
        },
      }),
    );
    return result;
  });

/** The tabs' poll. One scoped read, so it goes straight to the repository;
 *  the law report is parsed out of its column here so no client ever has to
 *  trust a JSON string. */
export const getRankloopArticles = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopArticlesSchema)
  .handler(async ({ context }) => {
    const rows = await ArticleRepository.getArticlesForProject(
      context.projectId,
    );
    return rows.map(({ lawReportJson, ...row }) => ({
      ...row,
      lawReport: parseLawReport(lawReportJson)?.laws ?? null,
    }));
  });

/** The detail screen: the draft, the brief it was written from, and the law
 *  report that judged it. */
export const getRankloopArticle = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopArticleSchema)
  .handler(async ({ context, data }) => {
    const article = await ArticleRepository.getArticleById(
      context.projectId,
      data.articleId,
    );
    if (!article) throw new AppError("NOT_FOUND", "Article not found.");
    const { lawReportJson, ...rest } = article;
    return { ...rest, lawReport: parseLawReport(lawReportJson)?.laws ?? null };
  });

/** Save an edited draft and re-grade it. No model call — assert it in tests,
 *  because the cheapest repair in the system staying free is what keeps the
 *  `drafts` dial worth using. */
export const recheckRankloopArticle = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(recheckRankloopArticleSchema)
  .handler(async ({ context, data }) => {
    const outcome = await ArticleGateService.recheck({
      projectId: context.projectId,
      articleId: data.articleId,
      content: data.content,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_writer:recheck",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          article_id: data.articleId,
          passed: outcome.passed,
          failed_count: outcome.failedCount,
        },
      }),
    );
    return outcome;
  });
