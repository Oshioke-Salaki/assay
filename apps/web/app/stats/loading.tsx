import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell current="/stats">
      <ScreenSkeleton label="Loading the numbers" figures={5} panels={[12, 8]} />
    </AppShell>
  );
}
