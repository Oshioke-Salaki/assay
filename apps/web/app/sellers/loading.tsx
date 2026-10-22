import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell current="/sellers">
      <ScreenSkeleton label="Loading sellers" figures={0} panels={[12, 12]} />
    </AppShell>
  );
}
