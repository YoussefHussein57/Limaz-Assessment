import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * Inter, loaded from a file in this repository rather than from Google.
 *
 * `next/font/google` resolves at BUILD time. The Docker image is built with no
 * guarantee that fonts.googleapis.com is reachable, and if it is not, the
 * build does not degrade - it fails, taking `docker compose up` with it on the
 * reviewer's machine. See apps/web/fonts/README.md.
 *
 * `display: swap` so text is readable immediately rather than invisible while
 * a 352 KB file arrives.
 */
const inter = localFont({
  src: '../fonts/InterVariable.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'LIMAZ Expense Policy',
  description: 'Multi-tenant expense policy service',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
