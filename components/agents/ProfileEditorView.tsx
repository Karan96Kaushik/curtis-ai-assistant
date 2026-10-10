import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import ModelChainPicker from '@/components/agents/ModelChainPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { validateProfile, outboundToolNames } from '@/amplify/functions/_shared/agent/profileRules';
import { agentApiConfigured } from '@/lib/amplify/client';
import { saveAgentProfile } from '@/lib/amplify/agent-functions';
import { chainFromModelIds, DEFAULT_MODEL_IDS, modelIdsFromChain, providersInChain } from '@/lib/agents/modelChain';
import { INTEGRATION_LABEL, INTEGRATION_ORDER, PERMISSION_TOOLS, type PermissionTool } from '@/lib/agents/toolCatalog';
import { getAgentProfile } from '@/lib/supabase/agentRuns';

const DEFAULT_PROMPT = 'Work toward the user\'s goal. Use tools for facts. Ask when something is ambiguous. Finish with a short summary.';

function rules() {
  return {
    knownTools: new Set(PERMISSION_TOOLS.map((tool) => tool.name)),
    outbound: outboundToolNames(PERMISSION_TOOLS),
  };
}

export default function ProfileEditorView() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(Boolean(profileId));
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [modelIds, setModelIds] = useState<string[]>([...DEFAULT_MODEL_IDS]);
  const [showErrors, setShowErrors] = useState(false);
  const [allowed, setAllowed] = useState<string[]>(['request_phone_notifications']);
  const [approval, setApproval] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState(25);
  const [maxRuntimeMin, setMaxRuntimeMin] = useState(60);
  const [tokenBudget, setTokenBudget] = useState(60000);

  useEffect(() => {
    if (!profileId) return;
    let active = true;
    getAgentProfile(profileId)
      .then((profile) => {
        if (!active) return;
        if (!profile) {
          setMissing(true);
          return;
        }
        setIsSystem(profile.is_system);
        setName(profile.name);
        setDescription(profile.description ?? '');
        setPrompt(profile.system_prompt);
        const ids = modelIdsFromChain(profile.model_chain);
        setModelIds(ids.length ? ids : [...DEFAULT_MODEL_IDS]);
        setAllowed(profile.allowed_tools);
        setApproval(profile.approval_required);
        setMaxSteps(profile.max_steps);
        setMaxRuntimeMin(profile.max_runtime_min);
        setTokenBudget(profile.token_budget);
      })
      .catch((err) => {
        if (active) toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [profileId]);

  const allowedSet = useMemo(() => new Set(allowed), [allowed]);
  const approvalSet = useMemo(() => new Set(approval), [approval]);
  const { chain, unknown } = chainFromModelIds(modelIds);
  const errors = useMemo(() => {
    const next = unknown.length ? [`Unknown model: ${unknown.join(', ')}`] : [];
    next.push(
      ...validateProfile(
        {
          name,
          description: description.trim() || null,
          system_prompt: prompt,
          allowed_tools: allowed,
          approval_required: approval,
          model_chain: chain,
          allowed_providers: providersInChain(chain),
          max_steps: maxSteps,
          max_runtime_min: maxRuntimeMin,
          token_budget: tokenBudget,
          resource_scopes: {},
        },
        rules()
      )
    );
    return next;
  }, [allowed, approval, chain, description, maxRuntimeMin, maxSteps, name, prompt, tokenBudget, unknown]);

  function toggleTool(tool: PermissionTool) {
    if (allowedSet.has(tool.name)) {
      setAllowed(allowed.filter((name) => name !== tool.name));
      setApproval(approval.filter((name) => name !== tool.name));
      return;
    }
    setAllowed([...allowed, tool.name]);
    if (tool.access === 'write') setApproval([...approval, tool.name]);
  }

  function toggleApproval(name: string) {
    setApproval(approvalSet.has(name) ? approval.filter((item) => item !== name) : [...approval, name]);
  }

  async function save() {
    if (errors.length) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAgentProfile({
        id: profileId,
        name,
        description,
        systemPrompt: prompt,
        allowedTools: allowed,
        approvalRequired: approval,
        modelIds,
        maxSteps,
        maxRuntimeMin,
        tokenBudget,
      });
      toast.success(`Saved ${saved.name}`);
      navigate('/agents');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading profile…</p>;
  if (missing) {
    return (
      <div className="p-6">
        <p className="text-sm">That profile is not available.</p>
        <Button asChild variant="link" className="px-0">
          <Link to="/agents">Back to agents</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-4 py-6">
      <Button asChild variant="link" className="w-fit px-0">
        <Link to="/agents">Agents</Link>
      </Button>
      <div>
        <h1 className="text-lg font-semibold">{profileId ? 'Edit profile' : 'New profile'}</h1>
        {isSystem && <p className="text-sm text-muted-foreground">This is the default Inbox profile. Runs without a chosen profile use it.</p>}
      </div>

      {!agentApiConfigured && (
        <p className="text-sm text-destructive">The agent API is not deployed yet, so this profile cannot be saved.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Description
            <Input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Instructions
            <Textarea value={prompt} maxLength={4000} onChange={(event) => setPrompt(event.target.value)} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Models</CardTitle>
          <CardDescription>Select every model this profile may use, then put them in fallback order.</CardDescription>
        </CardHeader>
        <CardContent>
          <ModelChainPicker modelIds={modelIds} onChange={setModelIds} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>
            These are the same functions the chat assistant can call. The agent only receives the ones you allow. ask_user,
            update_scratchpad, and finish are always available. Turning on a write requires approval until you clear it. Chat session
            controls such as confirm_pending are not listed; agent runs pause for approval instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {INTEGRATION_ORDER.map((integration) => {
            const tools = PERMISSION_TOOLS.filter((tool) => tool.integration === integration);
            return (
              <section key={integration} className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{INTEGRATION_LABEL[integration]}</h2>
                {tools.map((tool) => {
                  const on = allowedSet.has(tool.name);
                  return (
                    <div key={tool.name} className="rounded-md border px-3 py-2">
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-1" checked={on} onChange={() => toggleTool(tool)} />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{tool.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{tool.access}</span>
                          <Badge variant={tool.risk === 'high' ? 'destructive' : 'outline'} className="ml-2">
                            {tool.risk}
                          </Badge>
                          {!tool.connected && <span className="ml-2 text-xs text-muted-foreground">Not connected yet</span>}
                          <span className="mt-0.5 block text-muted-foreground">{tool.description}</span>
                        </span>
                      </label>
                      {on && tool.access === 'write' && (
                        <label className="mt-2 ml-6 flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={approvalSet.has(tool.name)} onChange={() => toggleApproval(tool.name)} />
                          Require approval
                        </label>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Limits</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            Max steps
            <Input type="number" min={1} max={100} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Max minutes
            <Input
              type="number"
              min={1}
              max={1440}
              value={maxRuntimeMin}
              onChange={(event) => setMaxRuntimeMin(Number(event.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Token budget
            <Input type="number" min={1000} max={500000} value={tokenBudget} onChange={(event) => setTokenBudget(Number(event.target.value))} />
          </label>
        </CardContent>
      </Card>

      {showErrors && errors.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <Button className="w-fit" disabled={saving || !agentApiConfigured} onClick={() => void save()}>
        {saving ? <Loader2 className="animate-spin" /> : null}
        Save profile
      </Button>
    </div>
  );
}
