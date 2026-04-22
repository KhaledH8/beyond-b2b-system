export const metadata = {
  title: 'Beyond Borders',
  description: 'Hotel search and booking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
