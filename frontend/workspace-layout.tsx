'use client';

import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Chat from './chat';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const showingChat = pathname === '/';
  const inWorkspace = showingChat || pathname === '/catalog';
  const prebuiltIds = searchParams.getAll('prebuilt');
  const consultPrebuiltId =
    showingChat && prebuiltIds.length === 1 ? prebuiltIds[0] : undefined;

  return (
    <>
      {inWorkspace && (
        // 目录导航只隐藏聊天，不卸载组件；进行中的流请求继续由同一实例读取。
        <div hidden={!showingChat}>
          <Chat active={showingChat} consultPrebuiltId={consultPrebuiltId} />
        </div>
      )}
      {children}
    </>
  );
}
