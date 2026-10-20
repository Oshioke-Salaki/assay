"use client";

import { useEffect } from "react";

/**
 * Section entrances: every element with [data-reveal] inside a section rises 24px and fades in
 * when the section enters, staggered by its data-reveal index (×75ms). Content is visible by default;
 * the hidden start state is only applied once this script runs and motion is allowed, so a failed
 * script or reduced motion never hides anything.
 */
export function Reveal() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const items = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const pending = items.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top > window.innerHeight * 0.92;
    });
    for (const el of pending) el.classList.add("reveal-wait");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          const step = Number(el.dataset.reveal ?? 0) || 0;
          el.style.transitionDelay = `${step * 75}ms`;
          el.classList.add("reveal-in");
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    for (const el of pending) io.observe(el);
    return () => io.disconnect();
  }, []);
  return null;
}
