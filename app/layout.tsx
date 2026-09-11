import type { Metadata } from 'next';
import './globals.css';
import './product.css';
import './chat.css';
import './generation.css';
import './task-memory.css';

export const metadata: Metadata = {
  title: '啵啵龙装机研究所 · 电脑选购与客服',
  description: '按预算与用途推荐主机，并提供有步骤的电脑基础故障排查。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
