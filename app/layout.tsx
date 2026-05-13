import type { Metadata, Viewport } from "next";
import "./globals.css";

// --font-mono is now defined in globals.css using a system monospace stack.
// Previously imported from next/font/google (DM_Mono), which made the
// production build fail when Google Fonts couldn't be fetched.

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
      <body className="font-mono bg-surface-base text-text-primary antialiased">
        {children}
      </body>
    </html>
  );
}
