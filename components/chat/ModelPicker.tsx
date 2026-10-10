import { Fragment } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { agentModelLabel, type AgentModel, type AgentRouter } from '@/lib/chat/models';

function groupByRouter(models: readonly AgentModel[]): { router: AgentRouter; models: AgentModel[] }[] {
  const groups: { router: AgentRouter; models: AgentModel[] }[] = [];
  for (const option of models) {
    const last = groups[groups.length - 1];
    if (last && last.router === option.router) last.models.push(option);
    else groups.push({ router: option.router, models: [option] });
  }
  return groups;
}

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
  const groups = groupByRouter(models);
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
          className="max-w-[22rem] text-muted-foreground"
        >
          <span className="truncate">{agentModelLabel(model)}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-80">
        {groups.map((group, index) => (
          <Fragment key={group.router}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.router}</DropdownMenuLabel>
            {group.models.map((option) => (
              <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)}>
                <Check className={option.id === model ? 'opacity-100' : 'opacity-0'} />
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.detail}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
