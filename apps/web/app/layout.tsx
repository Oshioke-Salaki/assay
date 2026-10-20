import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { Toaster } from "@/components/Toaster";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-schibsted",
  display: "swap",
});

const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: "Assay: the credit bureau for agent payments on Celo", template: "%s · Assay" },
  description:
    "Assay tests every x402 seller on Celo for organic revenue, nets out payment loops and self-funded payers, and signs a score any contract can verify.",
  openGraph: {
    title: "Assay",
    description: "The credit bureau for agent payments on Celo.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#161719",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={schibsted.variable}>
      <body>
        <Toaster>{children}</Toaster>
        <Analytics />
      </body>
    </html>
  );
}
