import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useArticlesPolling } from "@/client/features/rankloop-articles/useArticlesPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopWriterAccess,
  writeRankloopArticle,
} from "@/serverFunctions/rankloopWriter";

/** What the confirm modal needs to name the thing it is about to spend on. */
type WriteTarget = { id: string; target: string; title: string | null };

/**
 * The Write action's whole state machine, kept out of the proposals panel so
 * that screen stays a queue and this stays the one place generation is
 * started.
 *
 * Nothing here spends: the access read is free and the mutation only fires
 * from the confirm modal's button, so a mis-click on a row can cost at most a
 * dialog.
 */
export function useRankloopWriting(projectId: string) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<WriteTarget | null>(null);

  // Project-scoped, not per-row: whether a key exists is a fact about the
  // deployment, so one read decides every button in the table instead of N.
  const accessQuery = useQuery({
    queryKey: ["rankloopWriterAccess", projectId],
    queryFn: () => getRankloopWriterAccess({ data: { projectId } }),
    staleTime: 60 * 1000,
  });
  const access = accessQuery.data ?? null;

  const articlesQuery = useArticlesPolling(projectId);
  const articles = new Map(
    (articlesQuery.data ?? []).map((article) => [article.proposalId, article]),
  );

  const startMutation = useMutation({
    mutationFn: (proposalId: string) =>
      writeRankloopArticle({ data: { projectId, proposalId } }),
    onSuccess: () => {
      setConfirming(null);
      toast.success("Draft started");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't start the draft. Try again."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopArticles", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
    },
  });

  return {
    access,
    articles,
    confirming,
    isStarting: startMutation.isPending,
    // Optimistic-free by design: until the access read resolves we assume a
    // key is present, so the button renders rather than flashing the setup
    // pitch at every user who does have one.
    providerConfigured: access?.providerConfigured ?? true,
    pendingProposalId: startMutation.isPending
      ? (startMutation.variables ?? null)
      : null,
    openConfirm: (row: WriteTarget) => setConfirming(row),
    cancelConfirm: () => setConfirming(null),
    confirmWrite: () => {
      if (confirming) startMutation.mutate(confirming.id);
    },
  };
}
