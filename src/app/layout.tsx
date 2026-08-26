import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "lazyjudge",
  description:
    "minimalist coding speed test.",
  openGraph: {
    title: "lazyjudge",
    description: "minimalist coding speed test.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100..900;1,100..900&family=Roboto+Mono:ital,wght@0,100..700;1,100..700&family=Source+Code+Pro:ital,wght@0,200..900;1,200..900&display=swap"
          rel="stylesheet"
        />
        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3508670481189931"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      </head>
      <body style={{ fontFamily: "'Roboto Mono', 'Fira Code', 'Cascadia Code', monospace" }}>
        {children}
      </body>
    </html>
  );
}
