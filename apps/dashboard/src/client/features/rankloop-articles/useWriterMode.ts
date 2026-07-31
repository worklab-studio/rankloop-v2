import { useQuery } from "@tanstack/react-query";
import type { WriterMode } from "@/client/features/rankloop-articles/writerMode.logic";
import { getRankloopWriterSettings } from "@/serverFunctions/rankloopWriting";
import { WRITER_SETTINGS_DEFAULTS } from "@/shared/rankloop-writing";

/**
 * Which writer this project uses, for the screens that have to phrase
 * themselves differently in each mode.
 *
 * The same query key as the Writing settings form further down the Articles
 * screen, so switching the mode there flips the queue above it without a
 * reload, and the second and third caller cost a cache read rather than a
 * round-trip. Null means the project never saved settings, which is the
 * column default: this app writes.
 */
export function useWriterMode(projectId: string): WriterMode {
  const settingsQuery = useQuery({
    queryKey: ["rankloopWriterSettings", projectId],
    queryFn: () => getRankloopWriterSettings({ data: { projectId } }),
  });
  return settingsQuery.data?.writerMode ?? WRITER_SETTINGS_DEFAULTS.writerMode;
}
