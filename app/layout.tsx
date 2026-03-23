import type { Metadata, Viewport } from "next";
import { DM_Mono } from "next/font/google";
import "./globals.css";

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Trading — Agent Dashboard",
  description: "AI agent trading signal dashboard",
};

// Tells mobile browsers to use the device's actual width
// instead of zooming out to fit a desktop layout
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${dmMono.variable} font-mono bg-surface-base text-text-primary antialiased`}>
        {children}
      </body>
    </html>
  );
}
