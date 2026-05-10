import './globals.css';

export const metadata = {
  title: 'Beyond Borders — Admin',
  description: 'Internal operations console',
};

/**
 * Root layout — intentionally unguarded.
 *
 * The operator gate (ADR-029 D4) lives at
 * `app/(protected)/layout.tsx` so that public-shape routes — the
 * SDK-mounted `/auth/login` / `/auth/logout` / `/auth/callback`
 * and the static `/not-operator` 403 — can render without going
 * through the gate. The root layout does no I/O and stays static.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
