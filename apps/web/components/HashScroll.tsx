"use client";

import { useEffect } from "react";

/**
 * Scrolls to the URL's #section once it exists. Sections that mount after hydration (wallet
 * panels, lazy drawings) are not there when the browser does its own hash scroll, so a link to
 * them would otherwise land at the top of the page.
 */
export function HashScroll() {
  useEffect(() => {
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return true;
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      return true;
    };
    if (go()) return;
    let tries = 0;
    const t = setInterval(() => {
      if (go() || ++tries > 40) clearInterval(t);
    }, 100);
    const onHash = () => go();
    window.addEventListener("hashchange", onHash);
    return () => {
      clearInterval(t);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  return null;
}
