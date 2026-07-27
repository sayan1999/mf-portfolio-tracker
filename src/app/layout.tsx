import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Portfolio Tracker",
  description: "INDmoney MCP OAuth client",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f9fafb" }}>{children}</body>
    </html>
  );
}
