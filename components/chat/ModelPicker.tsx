import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { agentModelLabel, type AgentModel } from '@/lib/chat/models';

export default function ModelPicker({
  model,
  models,
  disabled,
  onChange,
}: {
  model: string;
  models: readonly AgentModel[];
  disabled?: boolean;
  onChange(id: string): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Model"
          title={agentModelLabel(model)}
          className="max-w-[16rem] text-muted-foreground"
        >
          <span className="truncate">{agentModelLabel(model)}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {models.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)}>
            <Check className={option.id === model ? 'opacity-100' : 'opacity-0'} />
            <span className="flex min-w-0 flex-col">
              <span>
                {option.label} <span className="text-muted-foreground">({option.router})</span>
              </span>
              <span className="text-xs text-muted-foreground">{option.detail}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
