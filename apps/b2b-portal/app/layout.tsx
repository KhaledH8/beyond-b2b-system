export const metadata = {
  title: 'Beyond Borders — Partner Portal',
  description: 'Agency, subscriber, and corporate portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
