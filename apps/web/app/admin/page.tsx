import type { Metadata } from "next";
import { AdminView } from "@/components/AdminView";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Operator",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <AppShell>
      <AdminView />
    </AppShell>
  );
}
