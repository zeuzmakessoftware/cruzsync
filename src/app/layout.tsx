import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CruzSync — Know what to take. Know where to wait.',
  description:
    'A Gemma-powered multi-leg commute and smart-waiting copilot for the Scotts Valley to UCSC journey on Santa Cruz METRO. Independent student project; not affiliated with Santa Cruz METRO.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
