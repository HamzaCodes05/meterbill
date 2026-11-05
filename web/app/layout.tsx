import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MeterBill: usage-based billing',
  description: 'Plans, usage metering and accurate invoices.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
