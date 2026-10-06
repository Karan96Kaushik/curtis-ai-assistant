import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return <img src="/icons/icon.svg" alt="" aria-hidden className={cn('size-7 rounded-lg', className)} />;
}
