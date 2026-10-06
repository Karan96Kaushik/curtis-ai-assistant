import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/layout/BrandMark';

export default function WorkingIndicator() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite">
      <BrandMark className="shrink-0" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-bounce rounded-full bg-primary/70"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        Curtis is working{seconds >= 3 ? ` · ${seconds}s` : '…'}
      </div>
    </div>
  );
}
