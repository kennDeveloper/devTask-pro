import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { TRPCProvider } from "@/lib/trpc/client";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "DevTask Pro",
    template: "%s · DevTask Pro",
  },
  description:
    "A private daily task tracker: one-off and recurring tasks, with overdue handled for you.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `suppressHydrationWarning` is required, not cosmetic: next-themes writes
    // the theme class onto <html> from an inline script before React hydrates,
    // so the server markup and the DOM React finds genuinely differ on this
    // element. Without it every page load logs a hydration mismatch.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* `attribute="class"` is what globals.css's
            `@custom-variant dark (&:is(.dark *))` and its `.dark` token block
            are written against. `defaultTheme="system"` + `enableSystem` mean
            a first-time visitor gets the theme their OS already asked for. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TRPCProvider>{children}</TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
