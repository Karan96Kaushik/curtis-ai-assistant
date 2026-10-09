import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadChatExport, type ExportableMessage } from '@/lib/chat/exportChat';

export default function ExportChatButton({
  title,
  messages,
  disabled,
}: {
  title: string;
  messages: readonly ExportableMessage[];
  disabled?: boolean;
}) {
  function save(format: 'markdown' | 'json') {
    downloadChatExport({ title, messages, format });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label="Export chat">
          <Download />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Export chat</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => save('markdown')}>Markdown</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => save('json')}>JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
