import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mem Palace",
  description: "Your second brain as a memory graph.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-palace-bg text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
