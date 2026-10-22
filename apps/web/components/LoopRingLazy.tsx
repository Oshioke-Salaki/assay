"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

/** The loop drawing loads only on reports that have a loop, and only in the browser. */
const LoopRing = dynamic(() => import("./LoopRing").then((m) => m.LoopRing), {
  ssr: false,
  loading: () => <div style={{ height: 300 }} aria-hidden="true" />,
});

export function LoopRingLazy(props: ComponentProps<typeof LoopRing>) {
  return <LoopRing {...props} />;
}
