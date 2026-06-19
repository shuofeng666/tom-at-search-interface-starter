import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TOM AT Search Interface",
  description: "Assistive technology search, evaluation, and review prototype for TOM."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
