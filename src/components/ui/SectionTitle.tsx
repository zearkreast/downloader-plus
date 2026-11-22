import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** A part of a page under its large title, as History's downloads and finished ones. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cn('text-[17px] font-semibold tracking-[-0.01em] text-fg', className)}>{children}</h2>
  );
}
