import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { THEME_INIT_SCRIPT } from "@/components/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "rankloop — Crema Notes",
  description:
    "Open-source SEO engine: every report ends in a Write button, every article reports back what it moved.",
};

/** The OpenSEO AppShell, ported: sidebar sits flat on the bg-base-200
 * canvas; the content lives on a raised bg-base-100 panel with a thin strip
 * of canvas above it and a hairline border (the PostHog-style cutout).
 * Theme (light/dark/system) is applied pre-paint by the inline script. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <div className="flex h-[100dvh] bg-base-200">
          <div className="hidden shrink-0 md:block">
            <Sidebar />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col md:pt-2">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-base-100 md:rounded-tl-lg md:border-l md:border-t md:border-base-300">
                <div className="min-h-0 flex-1 overflow-auto">
                  <div className="px-4 py-4 md:px-6 md:py-6">
                    <div className="mx-auto flex max-w-7xl flex-col gap-5">{children}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
