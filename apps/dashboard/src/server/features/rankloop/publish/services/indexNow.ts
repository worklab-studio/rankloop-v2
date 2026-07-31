import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// Step 7 of the publish workflow, alone in its own module: it is the only
// call in the feature that reaches a third party rankloop has no connection
// with, and the only one whose failure is not worth a line in the run's story.

/**
 * Tell the participating engines the URL exists. Best-effort, and silent when
 * the deployment has no key: IndexNow requires a key file hosted on the user's
 * own domain, so a key nobody installed would produce a 403 on every publish
 * and teach users to ignore the one line that reports it.
 */
export async function submitIndexNow(
  url: string,
): Promise<{ submitted: boolean }> {
  const key = await getOptionalEnvValue("INDEXNOW_KEY");
  if (!key || !url) return { submitted: false };
  try {
    const host = new URL(url).host;
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, key, urlList: [url] }),
    });
    return { submitted: response.ok };
  } catch {
    return { submitted: false };
  }
}
