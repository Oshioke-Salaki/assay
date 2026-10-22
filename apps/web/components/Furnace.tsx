"use client";

import { useEffect, useRef, useState } from "react";
import { API_PUBLIC } from "@/lib/api";
import { int } from "@/lib/format";
import styles from "./app.module.css";

const HEIGHT = 96;
const POLL_MS = 20_000;
const MAX_DRAWN = 240;

/**
 * The furnace is lit: a bead drops into the crucible for every settlement indexed since the page
 * was opened. Polls the economy totals every twenty seconds while the tab is visible. With
 * reduced motion the beads appear in place.
 */
export function Furnace({ initialSettlements }: { initialSettlements: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [since, setSince] = useState(0);
  const [stale, setStale] = useState(false);
  const pending = useRef(0);

  useEffect(() => {
    let last = initialSettlements;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`${API_PUBLIC}/v1/economy`, { cache: "no-store" });
          if (res.ok) {
            const e = (await res.json()) as { settlements: number };
            if (Number.isFinite(e.settlements) && e.settlements > last) {
              pending.current += e.settlements - last;
              setSince((n) => n + (e.settlements - last));
              last = e.settlements;
            }
            setStale(false);
          } else setStale(true);
        } catch {
          setStale(true);
        }
      }
      timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [initialSettlements]);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim() || "#141414";
    const rule = css.getPropertyValue("--app-rule").trim() || "#e3e4e6";
    const gold = css.getPropertyValue("--data").trim() || "#8a6d00";
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let width = 0;
    const settled: { x: number; y: number }[] = [];
    const falling: { x: number; y: number; vy: number; tx: number; ty: number }[] = [];

    const size = () => {
      width = el.clientWidth;
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(HEIGHT * dpr);
      cv.style.width = `${width}px`;
      cv.style.height = `${HEIGHT}px`;
    };
    // The crucible: a shallow bowl across the bottom; beads settle inside it.
    const bowl = () => ({ left: width * 0.2, right: width * 0.8, top: HEIGHT - 34, bottom: HEIGHT - 6 });
    const restingSpot = (i: number) => {
      const b = bowl();
      const cols = Math.max(8, Math.floor((b.right - b.left) / 7));
      const col = i % cols;
      const row = Math.floor(i / cols);
      return { x: b.left + 4 + col * 7 + (row % 2) * 3.5, y: b.bottom - 3 - row * 6 };
    };
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);
      const b = bowl();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(b.left - 8, b.top);
      ctx.lineTo(b.left, b.bottom);
      ctx.lineTo(b.right, b.bottom);
      ctx.lineTo(b.right + 8, b.top);
      ctx.stroke();
      ctx.strokeStyle = rule;
      ctx.beginPath();
      ctx.moveTo(0, b.bottom + 4);
      ctx.lineTo(width, b.bottom + 4);
      ctx.stroke();
      ctx.fillStyle = gold;
      for (const p of settled) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = ink;
      for (const p of falling) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    let raf = 0;
    let running = false;
    let lastT = 0;
    const step = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
      lastT = now;
      // Release pending beads a few at a time so a burst reads as a stream.
      let release = Math.min(3, pending.current);
      while (release-- > 0 && pending.current > 0) {
        pending.current--;
        const i = settled.length + falling.length;
        const spot = restingSpot(i);
        const x = spot.x + (Math.random() - 0.5) * 6;
        falling.push({ x, y: -4, vy: 40 + Math.random() * 60, tx: spot.x, ty: spot.y });
      }
      for (let i = falling.length - 1; i >= 0; i--) {
        const f = falling[i]!;
        f.vy += 420 * dt;
        f.y += f.vy * dt;
        f.x += (f.tx - f.x) * Math.min(1, dt * 4);
        if (f.y >= f.ty) {
          settled.push({ x: f.tx, y: f.ty });
          falling.splice(i, 1);
        }
      }
      if (settled.length > MAX_DRAWN) settled.splice(0, settled.length - MAX_DRAWN);
      draw();
      // Idle when nothing moves, so a quiet page costs nothing.
      if (falling.length === 0 && pending.current === 0) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    const wake = () => {
      if (reduced) {
        while (pending.current > 0) {
          pending.current--;
          settled.push(restingSpot(settled.length));
        }
        if (settled.length > MAX_DRAWN) settled.splice(0, settled.length - MAX_DRAWN);
        draw();
        return;
      }
      if (!running && document.visibilityState === "visible") {
        running = true;
        lastT = 0;
        raf = requestAnimationFrame(step);
      }
    };
    const ro = new ResizeObserver(() => {
      size();
      draw();
    });
    size();
    draw();
    ro.observe(el);
    const ticker = setInterval(() => {
      if (pending.current > 0) wake();
    }, 500);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      clearInterval(ticker);
      ro.disconnect();
    };
  }, []);

  return (
    <div>
      <div ref={box} style={{ width: "100%", height: HEIGHT }}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${int(since)} settlements indexed since this page was opened`}
          style={{ display: "block" }}
        />
      </div>
      <p className={styles.kpiNote} style={{ marginTop: 8 }} aria-live="polite">
        {since === 0
          ? "Waiting for the next settlement. Each one drops into the crucible as Assay indexes it."
          : `${int(since)} settlement${since === 1 ? "" : "s"} indexed since you opened this page.`}
        {stale ? " The API did not answer the last check." : ""}
      </p>
    </div>
  );
}
