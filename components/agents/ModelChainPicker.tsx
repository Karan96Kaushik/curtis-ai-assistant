import { Fragment } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AGENT_MODELS, agentModelLabel, type AgentModel, type AgentRouter } from '@/lib/chat/models';

function groupByRouter(models: readonly AgentModel[]): { router: AgentRouter; models: AgentModel[] }[] {
  const groups: { router: AgentRouter; models: AgentModel[] }[] = [];
  for (const option of models) {
    const last = groups[groups.length - 1];
    if (last && last.router === option.router) last.models.push(option);
    else groups.push({ router: option.router, models: [option] });
  }
  return groups;
}

export default function ModelChainPicker({
  modelIds,
  onChange,
}: {
  modelIds: string[];
  onChange(ids: string[]): void;
}) {
  const selected = new Set(modelIds);
  const groups = groupByRouter(AGENT_MODELS);

  function toggle(id: string) {
    if (selected.has(id)) onChange(modelIds.filter((item) => item !== id));
    else onChange([...modelIds, id]);
  }

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= modelIds.length) return;
    const copy = [...modelIds];
    const current = copy[index];
    const swap = copy[next];
    if (!current || !swap) return;
    copy[index] = swap;
    copy[next] = current;
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">Tried in this order. If one is rate limited, the next model runs the same step.</p>
        {modelIds.length === 0 ? (
          <p className="text-sm">No models selected.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {modelIds.map((id, index) => (
              <li key={id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                <span className="w-5 text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{agentModelLabel(id)}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <ChevronUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move later"
                  disabled={index === modelIds.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <Fragment key={group.router}>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium text-muted-foreground">{group.router}</legend>
              {group.models.map((model) => (
                <label key={model.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(model.id)}
                    onChange={() => toggle(model.id)}
                  />
                  <span>
                    {model.label}
                    <span className="ml-2 text-xs text-muted-foreground">{model.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
