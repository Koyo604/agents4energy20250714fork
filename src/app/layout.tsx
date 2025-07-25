import type { Metadata } from "next";
import localFont from "next/font/local";
import "@cloudscape-design/global-styles/index.css"
import "./globals.scss";

import ConfigureAmplify from '@/components/ConfigureAmplify';
import Providers from '@/components/ContextProviders';

// import TopNavBar from '@/components/TopNavBar';
import ClientLayout from '@/components/ClientLayout';

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Agents4Energy - サンプル",
  description: "AIを活用してエネルギー業務を改善",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>
          <ConfigureAmplify/>
          <ClientLayout>
            {children}
          </ClientLayout>
          {/* <TopNavBar/>
          <Toolbar />
          {children} */}
        </Providers>
      </body>
    </html>
  );
}
