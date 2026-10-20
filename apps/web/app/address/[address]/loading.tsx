import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell>
      <ScreenSkeleton label="Assaying this address" figures={4} panels={[3, 8]} />
    </AppShell>
  );
}
