import { AppShell, ErrorState } from "@/components/AppShell";

export default function NotFound() {
  return (
    <AppShell>
      <ErrorState
        title="Nothing here"
        message="That page or address does not exist. Addresses are 0x followed by 40 hex characters."
      />
    </AppShell>
  );
}
