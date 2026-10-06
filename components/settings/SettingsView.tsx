import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTheme } from 'next-themes';
import { CheckCircle2, Loader2, LogOut, Monitor, Moon, Sun, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { functionsConfigured } from '@/lib/amplify/client';
import { newPasswordSchema, type NewPasswordValues } from '@/lib/auth/schemas';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-start gap-3">
      <Icon className={cn('mt-0.5 size-4 shrink-0', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')} />
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export default function SettingsView() {
  const { user, configured, updatePassword, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    document.title = 'Settings · Curtis';
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema), defaultValues: { password: '', confirm: '' } });

  const onChangePassword = handleSubmit(async ({ password }) => {
    try {
      await updatePassword(password);
      reset();
      toast.success('Password updated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  });

  async function handleSignOut() {
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Your account and how Curtis looks.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Signed in with Supabase.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user?.email}</p>
              {user?.created_at && (
                <p className="text-xs text-muted-foreground">
                  Member since {new Date(user.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </p>
              )}
            </div>
            <Button variant="outline" onClick={handleSignOut}>
              <LogOut />
              Sign out
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose a theme for this device.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
              {THEMES.map(({ value, label, icon: Icon }) => {
                const active = mounted && theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTheme(value)}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-sm transition-colors hover:bg-accent',
                      active && 'border-primary bg-primary/5 ring-1 ring-primary'
                    )}
                  >
                    <Icon className="size-5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>Use at least 8 characters.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 sm:max-w-sm" onSubmit={onChangePassword} noValidate>
              <div className="grid gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input id="new-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
                {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} />
                {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
              </div>
              <Button type="submit" className="w-fit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="animate-spin" />}
                Update password
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Backend</CardTitle>
            <CardDescription>What this build is connected to.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <StatusRow
              ok={configured}
              label="Supabase"
              detail={configured ? 'Auth and chat history are connected.' : 'Set VITE_SUPABASE_URL_CURTIS and VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS.'}
            />
            <StatusRow
              ok={functionsConfigured}
              label="Chat function"
              detail={
                functionsConfigured
                  ? 'Amplify Function URL found in amplify_outputs.json.'
                  : 'Run npm run amplify:sandbox to deploy it.'
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
