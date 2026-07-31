"use client";

/** Theme preference (OpenSEO's ThemePreferenceMenuItems idiom): Light /
 * Dark / System, persisted in localStorage, applied as data-theme on <html>
 * (openseo | openseo-dark). The inline script in layout.tsx applies the
 * stored choice before first paint so there is no flash. */

import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

export type ThemePref = "light" | "dark" | "system";
const STORAGE_KEY = "rl-theme";

export function applyTheme(pref: ThemePref) {
  const dark =
    pref === "dark" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "openseo-dark" : "openseo");
}

export function readThemePref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

/** Menu rows for the account dropdown — same shape as OpenSEO's. */
export function ThemePreferenceMenuItems() {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => setPref(readThemePref()), []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readThemePref() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const choose = (next: ThemePref) => {
    setPref(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  const items: { key: ThemePref; label: string; icon: typeof Sun }[] = [
    { key: "light", label: "Light", icon: Sun },
    { key: "dark", label: "Dark", icon: Moon },
    { key: "system", label: "System", icon: Monitor },
  ];

  return (
    <>
      {items.map(({ key, label, icon: Icon }) => (
        <li key={key}>
          <button type="button" onClick={() => choose(key)}>
            <Icon className="h-4 w-4" />
            {label}
            {pref === key ? <Check className="ml-auto h-4 w-4" /> : null}
          </button>
        </li>
      ))}
    </>
  );
}

/** Inline script body for layout.tsx — runs before hydration. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"openseo-dark":"openseo");}catch(e){document.documentElement.setAttribute("data-theme","openseo");}})();`;
