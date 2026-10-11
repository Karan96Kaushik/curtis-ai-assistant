import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import ModelChainPicker from '@/components/agents/ModelChainPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ensureEgressApproval,
  egressToolNames,
  normalizeAllowedTools,
  validateProfile,
} from '@/amplify/functions/_shared/agent/profileRules';
import { agentApiConfigured } from '@/lib/amplify/client';
import { analyzeProfileRun, saveAgentProfile, type ProfileRunSuggestion } from '@/lib/amplify/agent-functions';
import { chainFromModelIds, DEFAULT_MODEL_IDS, modelIdsFromChain, providersInChain } from '@/lib/agents/modelChain';
import {
  INBOX_TOOLS,
  INTEGRATION_LABEL,
  INTEGRATION_ORDER,
  PERMISSION_TOOLS,
  type PermissionTool,
} from '@/lib/agents/toolCatalog';
import { getAgentProfile, listAgentRunsForProfile } from '@/lib/supabase/agentRuns';
import type { AgentRunRow } from '@/lib/supabase/types';

const DEFAULT_PROMPT =
  'Work toward the user\'s goal. Notifications are truncated previews, not full messages — say so when it matters. Call notification_app_stats before search_notifications so you know which apps are active. Use tools for facts. Ask when something is ambiguous. Finish with a short summary.';

function rules() {
  return {
    knownTools: new Set(PERMISSION_TOOLS.map((tool) => tool.name)),
    egress: egressToolNames(PERMISSION_TOOLS),
  };
}

function runLabel(run: AgentRunRow): string {
  const when = new Date(run.updated_at).toLocaleString();
  const command = run.command.replace(/\s+/g, ' ').trim().slice(0, 72);
  return `${run.status} · ${when} · ${command}`;
}

export default function ProfileEditorView() {
  const { profileId } = useParams();
  const [searchParams] = useSearchParams();
  const analyzeRunId = searchParams.get('analyzeRun') ?? '';
  const navigate = useNavigate();
  const [loading, setLoading] = useState(Boolean(profileId));
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<AgentRunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(analyzeRunId);
  const [analyzing, setAnalyzing] = useState(false);
  const [suggestion, setSuggestion] = useState<ProfileRunSuggestion | null>(null);
  const [proposedPrompt, setProposedPrompt] = useState('');
  const [isSystem, setIsSystem] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [savedAsDefault, setSavedAsDefault] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [modelIds, setModelIds] = useState<string[]>([...DEFAULT_MODEL_IDS]);
  const [showErrors, setShowErrors] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([...INBOX_TOOLS]);
  const [approval, setApproval] = useState<string[]>([]);
  const [allowedAppsText, setAllowedAppsText] = useState('');
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
        setIsDefault(profile.is_default);
        setSavedAsDefault(profile.is_default);
        setName(profile.name);
        setDescription(profile.description ?? '');
        setPrompt(profile.system_prompt);
        const ids = modelIdsFromChain(profile.model_chain);
        setModelIds(ids.length ? ids : [...DEFAULT_MODEL_IDS]);
        const tools = normalizeAllowedTools(profile.allowed_tools ?? []);
        setAllowed(tools);
        setApproval(ensureEgressApproval(tools, profile.approval_required ?? []));
        setAllowedAppsText((profile.allowed_apps ?? []).join(', '));
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

  useEffect(() => {
    if (!profileId) return;
    let active = true;
    listAgentRunsForProfile(profileId)
      .then((next) => {
        if (!active) return;
        setRuns(next);
        setSelectedRunId((current) => current || analyzeRunId || next[0]?.id || '');
      })
      .catch((err) => {
        if (active) toast.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [analyzeRunId, profileId]);

  const allowedSet = useMemo(() => new Set(allowed), [allowed]);
  const approvalSet = useMemo(() => new Set(approval), [approval]);
  const allowedApps = useMemo(
    () =>
      allowedAppsText
        .split(/[,|\n]/)
        .map((app) => app.trim())
        .filter(Boolean),
    [allowedAppsText]
  );
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
          allowed_apps: allowedApps,
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
  }, [allowed, allowedApps, approval, chain, description, maxRuntimeMin, maxSteps, name, prompt, tokenBudget, unknown]);

  function toggleTool(tool: PermissionTool) {
    if (allowedSet.has(tool.name)) {
      const nextAllowed = allowed.filter((name) => name !== tool.name);
      setAllowed(nextAllowed);
      setApproval(ensureEgressApproval(nextAllowed, approval.filter((name) => name !== tool.name)));
      return;
    }
    const nextAllowed = [...allowed, tool.name];
    setAllowed(nextAllowed);
    setApproval(ensureEgressApproval(nextAllowed, tool.access === 'write' || tool.egress ? [...approval, tool.name] : approval));
  }

  function toggleApproval(name: string) {
    setApproval(approvalSet.has(name) ? approval.filter((item) => item !== name) : [...approval, name]);
  }

  async function analyze() {
    if (!selectedRunId) return;
    setAnalyzing(true);
    try {
      const next = await analyzeProfileRun(selectedRunId);
      setSuggestion(next);
      setProposedPrompt(next.suggested_system_prompt);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  function applySuggestion() {
    if (!proposedPrompt.trim()) return;
    setPrompt(proposedPrompt);
    toast.success('Copied into Instructions. Save the profile to keep it.');
  }

  function discardSuggestion() {
    setSuggestion(null);
    setProposedPrompt('');
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
        allowedApps,
        modelIds,
        maxSteps,
        maxRuntimeMin,
        tokenBudget,
        isDefault,
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
        {isSystem && (
          <p className="text-sm text-muted-foreground">
            Built-in Inbox profile. It is used when no profile is marked as the default.
          </p>
        )}
      </div>

      {!agentApiConfigured && (
        <p className="text-sm text-destructive">The agent API is not deployed yet, so this profile cannot be saved.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={isDefault}
              disabled={savedAsDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            <span>
              Default profile
              <span className="mt-0.5 block text-muted-foreground">
                {savedAsDefault
                  ? 'Runs without a chosen profile use this one. Set another profile as the default to change it.'
                  : 'Runs without a chosen profile use this one.'}
              </span>
            </span>
          </label>
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

      {profileId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Improve from a run</CardTitle>
            <CardDescription>
              Analyze one finished run. Suggestions stay here until you apply them and save the profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {runs.length === 0 && !analyzeRunId ? (
              <p className="text-sm text-muted-foreground">No finished runs for this profile yet.</p>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  Run
                  <select
                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={selectedRunId}
                    onChange={(event) => setSelectedRunId(event.target.value)}
                  >
                    {analyzeRunId && !runs.some((run) => run.id === analyzeRunId) && (
                      <option value={analyzeRunId}>Selected run</option>
                    )}
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {runLabel(run)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  className="w-fit"
                  variant="outline"
                  disabled={analyzing || !selectedRunId || !agentApiConfigured}
                  onClick={() => void analyze()}
                >
                  {analyzing ? <Loader2 className="animate-spin" /> : null}
                  Analyze this run
                </Button>
              </>
            )}
            {suggestion && (
              <div className="flex flex-col gap-3 rounded-md border px-3 py-3">
                <p className="text-sm whitespace-pre-wrap">{suggestion.rationale}</p>
                {suggestion.change_bullets.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {suggestion.change_bullets.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                <label className="flex flex-col gap-1 text-sm">
                  Proposed instructions
                  <Textarea
                    value={proposedPrompt}
                    maxLength={4000}
                    onChange={(event) => setProposedPrompt(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!proposedPrompt.trim()} onClick={applySuggestion}>
                    Apply suggestion
                  </Button>
                  <Button size="sm" variant="outline" onClick={discardSuggestion}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
          <CardTitle className="text-base">Notification apps</CardTitle>
          <CardDescription>
            Leave empty to allow every non-sensitive app. Banking, OTP, and authenticator apps stay hidden unless you list them.
            Comma-separated app names or package fragments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            value={allowedAppsText}
            placeholder="Gmail, Slack"
            onChange={(event) => setAllowedAppsText(event.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>
            Messaging is notification-only. The agent only receives the tools you allow. ask_user, update_scratchpad, and finish are
            always available. A write that leaves your devices needs approval when the profile can also read notifications.
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
