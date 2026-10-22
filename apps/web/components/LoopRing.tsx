"use client";

import { useEffect, useMemo, useRef } from "react";
import { int, usd } from "@/lib/format";
import { beadBudget, beadPoint, type Flow, layoutRing, pickSpokes, type Spoke, seeded } from "@/lib/loopring";
import styles from "./app.module.css";

export interface LoopFlow extends Flow {
  /** Money from a wallet the seller funded (struck out), drawn in the negative colour. */
  funded?: boolean;
}

const HEIGHT = 300;
/** One full trip for a bead, in seconds; each bead gets its own speed around this. */
const TRIP_S = 7;

/**
 * The seller's money, drawn: the seller in the middle, every wallet it trades with around it,
 * beads of dollars moving along the spokes. Beads from loop members go in and come straight back
 * out, which is the whole finding. Runs only while on screen and the tab is visible; with
 * reduced motion it draws one still frame. Pure canvas, no library.
 */
export function LoopRing({
  inflows,
  outflows,
  loopSize,
  organicUsd,
  grossUsd,
}: {
  inflows: LoopFlow[];
  outflows: LoopFlow[];
  loopSize: number;
  organicUsd: number;
  grossUsd: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { kept, dropped } = useMemo(() => pickSpokes(inflows, outflows), [inflows, outflows]);
  const fundedBy = useMemo(() => new Map(inflows.map((f) => [f.address, Boolean(f.funded)])), [inflows]);
  const loopIn = inflows.filter((f) => f.inLoop).reduce((n, f) => n + f.usd, 0);
  const loopOut = outflows.filter((f) => f.inLoop).reduce((n, f) => n + f.usd, 0);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = getComputedStyle(document.documentElement);
    const colour = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const C = {
      ink: colour("--ink", "#141414"),
      gold: colour("--data", "#8a6d00"),
      grey: "#9a9ca2",
      rule: colour("--app-rule", "#e3e4e6"),
      bad: colour("--negative", "#b42318"),
      muted: colour("--app-muted", "#5d6068"),
    };

    let spokes: Spoke[] = [];
    let beads: { spoke: number; phase: number; speed: number }[] = [];
    let width = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const layout = () => {
      width = el.clientWidth;
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(HEIGHT * dpr);
      cv.style.width = `${width}px`;
      cv.style.height = `${HEIGHT}px`;
      spokes = layoutRing(kept, width, HEIGHT);
      const budget = beadBudget(spokes);
      beads = [];
      spokes.forEach((_, i) => {
        for (let k = 0; k < (budget[i] ?? 1); k++) {
          const n = i * 131 + k;
          beads.push({ spoke: i, phase: seeded(n), speed: 0.75 + seeded(n + 1) * 0.5 });
        }
      });
    };

    const toneOf = (s: Spoke) => (s.inLoop ? C.grey : fundedBy.get(s.address) ? C.bad : C.gold);

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);
      const cx = width / 2;
      const cy = HEIGHT / 2;
      // Spokes.
      ctx.lineWidth = 1;
      for (const s of spokes) {
        ctx.strokeStyle = C.rule;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      // Beads.
      for (const b of beads) {
        const s = spokes[b.spoke];
        if (!s) continue;
        const phase = (b.phase + (t / TRIP_S) * b.speed) % 1;
        const p = beadPoint(s, cx, cy, phase);
        ctx.fillStyle = toneOf(s);
        ctx.globalAlpha = s.inLoop ? 0.75 : 0.95;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Wallets.
      for (const s of spokes) {
        ctx.fillStyle = toneOf(s);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // The seller.
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(cx, cy, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("seller", cx, cy + 0.5);
    };

    let raf = 0;
    let running = false;
    let start = 0;
    const frame = (now: number) => {
      if (!running) return;
      if (!start) start = now;
      draw((now - start) / 1000);
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      if (running || reduced) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    let onScreen = false;
    const io = new IntersectionObserver(
      ([e]) => {
        onScreen = Boolean(e?.isIntersecting);
        if (onScreen && document.visibilityState === "visible") run();
        else stop();
      },
      // Runs only when a real part of the drawing is on screen, not a sliver at the fold.
      { threshold: 0.15 },
    );
    const onVisibility = () => {
      if (document.visibilityState === "visible" && onScreen) run();
      else stop();
    };
    const ro = new ResizeObserver(() => {
      layout();
      // A still frame keeps the drawing right while resizing, or forever with reduced motion.
      draw(reduced ? 2.3 : 0);
    });
    layout();
    draw(reduced ? 2.3 : 0);
    ro.observe(el);
    io.observe(el);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [kept, fundedBy]);

  const label = `${int(loopSize)} wallets pay each other. ${usd(loopIn)} came in from the loop and ${usd(loopOut)} went back out; ${usd(organicUsd)} of ${usd(grossUsd)} came from outside it.`;

  return (
    <div>
      <div ref={box} style={{ width: "100%", height: HEIGHT }}>
        <canvas ref={canvas} role="img" aria-label={label} style={{ display: "block" }} />
      </div>
      <div className={styles.legend} style={{ flexWrap: "wrap", marginTop: 8 }}>
        <span>
          <span className={styles.dot} style={{ background: "#9a9ca2" }} />
          in the loop: comes in, goes back out
        </span>
        <span>
          <span className={styles.dot} style={{ background: "var(--data)" }} />
          from outside: counts
        </span>
        {inflows.some((f) => f.funded) ? (
          <span>
            <span className={styles.dot} style={{ background: "var(--negative)" }} />
            from wallets it funded: struck out
          </span>
        ) : null}
        {dropped > 0 ? <span className={styles.muted}>+{int(dropped)} smaller wallets not drawn</span> : null}
      </div>
      <p className={styles.kpiNote} style={{ marginTop: 8, maxWidth: "80ch" }}>
        {label}
      </p>
    </div>
  );
}
