import { AppShell } from "@/components/AppShell";
import { ScreenSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <AppShell current="/agents">
      <ScreenSkeleton label="Loading this agent" figures={4} panels={[6]} />
    </AppShell>
  );
}
