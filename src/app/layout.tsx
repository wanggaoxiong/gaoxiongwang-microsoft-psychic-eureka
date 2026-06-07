import './globals.css';
import type { Metadata } from 'next';
import { SideNav } from '@/lib/ui/SideNav';
import { CommandPalette } from '@/lib/ui/CommandPalette';

export const metadata: Metadata = {
  title: 'WhatsApp AI Sales',
  description: 'AI 私域销售助手'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex h-screen">
          <SideNav />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
        <CommandPalette />
      </body>
    </html>
  );
}
