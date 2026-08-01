// Product identity, in one place.
//
// This app is a vendored fork of OpenSEO (MIT) — see ATTRIBUTION.md. The shell
// a user meets is rankloop, but the credit is not buried in a license file:
// UPSTREAM_REPO_URL is rendered in the sidebar footer and in Settings → About.
//
// Two different repos on purpose:
//   RANKLOOP_REPO_URL  — where rankloop's own features and docs live. Anything
//                        this fork added (the pipeline, articles, receipts,
//                        the rankloop skill) links here.
//   UPSTREAM_REPO_URL  — every-app/open-seo. Anything that documents UPSTREAM's
//                        features (its Cloudflare self-hosting guide, its GSC
//                        OAuth doc) keeps pointing here; re-hosting those docs
//                        under rankloop's name would misattribute their work.

export const RANKLOOP_REPO_URL =
  "https://github.com/worklab-studio/rankloop-v2";

export const UPSTREAM_REPO_URL = "https://github.com/every-app/open-seo";

// The name this app introduces itself with to OTHER people's servers. It is
// product identity too: it lands in their access logs, and the audit UI tells
// users to allowlist it by name, so the string here and the string in that copy
// have to move together. Defined once for exactly that reason.
export const AUDIT_CRAWLER_NAME = "rankloop-Audit";
export const AUDIT_USER_AGENT = `${AUDIT_CRAWLER_NAME}/1.0 (+${RANKLOOP_REPO_URL})`;
export const SCRAPE_USER_AGENT = `rankloop-Onboarding/1.0 (+${RANKLOOP_REPO_URL})`;
