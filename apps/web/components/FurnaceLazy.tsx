"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

const Furnace = dynamic(() => import("./Furnace").then((m) => m.Furnace), {
  ssr: false,
  loading: () => <div style={{ height: 96 }} aria-hidden="true" />,
});

export function FurnaceLazy(props: ComponentProps<typeof Furnace>) {
  return <Furnace {...props} />;
}
