import { redirect } from "next/navigation";

/** No-script fallback for the address form: /address?a=0x… → /address/0x… */
export default async function AddressLookup({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const { a } = await searchParams;
  const v = (a ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) redirect(`/address/${v.toLowerCase()}`);
  redirect("/#assay");
}
