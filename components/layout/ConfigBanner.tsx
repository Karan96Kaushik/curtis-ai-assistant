import { TriangleAlert } from 'lucide-react';

export default function ConfigBanner() {
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p>
        The chat backend isn’t deployed yet: <code className="font-mono text-xs">amplify_outputs.json</code> has no
        function URLs. Run <code className="font-mono text-xs">npm run amplify:sandbox</code> and reload.
      </p>
    </div>
  );
}
