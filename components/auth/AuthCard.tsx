import type { ReactNode } from 'react';
import { BrandMark } from '@/components/layout/BrandMark';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-gradient-to-b from-primary/5 to-transparent px-4 py-12">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <BrandMark className="size-8" />
        Curtis
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}
