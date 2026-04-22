export const metadata = {
  title: 'Beyond Borders — Admin',
  description: 'Internal operations console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
