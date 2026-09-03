import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/space-grotesk/600.css";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "SentiRev",
  description: "A consistent, explainable review on every pull request.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
