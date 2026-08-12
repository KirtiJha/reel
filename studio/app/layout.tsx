import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Reel Studio",
  description: "Lights, camera, code. — Author, render, narrate, and keep web demos from going stale.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="grid min-h-screen grid-cols-[248px_1fr] max-[860px]:grid-cols-1">
          <Sidebar />
          <main className="mx-auto w-full max-w-[1180px] px-10 pb-16 pt-8 max-[860px]:px-5">{children}</main>
        </div>
      </body>
    </html>
  );
}
