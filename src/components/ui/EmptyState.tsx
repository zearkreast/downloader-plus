import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

interface EmptyStateProps {
  /** A lucide icon, passed as the component: `icon={Download}`. */
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * What a screen shows when it has nothing to list: one muted icon, a line
 * saying so, a line saying what to do about it, and the button that does it.
 * It does not animate in -- the screen change that brought it has already moved.
 */
export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {/* The icon sits in a tile with a breath of the accent behind it: the
          same light the mark gives off on Home, turned right down. */}
      <span aria-hidden="true" className="relative mb-5 flex size-16 items-center justify-center">
        <span className="absolute inset-0 rounded-[20px] bg-[image:var(--brand-gradient)] opacity-[0.16] blur-xl" />
        <span className="surface-card relative flex size-16 items-center justify-center rounded-[20px]">
          <Icon size={28} strokeWidth={1.6} className="text-accent" />
        </span>
      </span>
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">{title}</h3>
      {body && <p className="mt-1.5 max-w-[320px] text-[13px] leading-relaxed text-fg-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
