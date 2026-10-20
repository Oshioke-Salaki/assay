import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell current="/economy">
      <ScreenSkeleton label="Loading the economy" figures={4} panels={[6, 8]} />
    </AppShell>
  );
}
