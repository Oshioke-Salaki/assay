import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell current="/agents">
      <ScreenSkeleton label="Loading agents" figures={0} panels={[12]} />
    </AppShell>
  );
}
