import { useState } from 'react';
import { Navigate, useLocation, useNavigate, type Location } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import AuthCard from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

const COPY: Record<Mode, { title: string; description: string; submit: string }> = {
  'sign-in': { title: 'Welcome back', description: 'Sign in to chat with Curtis.', submit: 'Sign in' },
  'sign-up': { title: 'Create an account', description: 'Your email must be on the allow list to chat.', submit: 'Create account' },
  forgot: { title: 'Reset your password', description: 'We’ll email you a link to set a new one.', submit: 'Send reset link' },
};

const schema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string(),
});

type FormValues = z.infer<typeof schema>;

export default function LoginView() {
  const { session, loading, configured, signIn, signUp, sendPasswordReset } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from?.pathname ?? '/';
  const [mode, setMode] = useState<Mode>('sign-in');

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  if (!loading && session) return <Navigate to={from} replace />;

  const onSubmit = handleSubmit(async ({ email, password }) => {
    if (mode !== 'forgot' && password.length < (mode === 'sign-up' ? 8 : 1)) {
      setError('password', { message: mode === 'sign-up' ? 'Use at least 8 characters' : 'Enter your password' });
      return;
    }
    try {
      if (mode === 'sign-in') {
        await signIn(email, password);
        navigate(from, { replace: true });
      } else if (mode === 'sign-up') {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) {
          toast.success('Check your inbox to confirm your email.');
          setMode('sign-in');
        } else {
          navigate(from, { replace: true });
        }
      } else {
        await sendPasswordReset(email);
        toast.success('If that email has an account, a reset link is on its way.');
        setMode('sign-in');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  });

  const copy = COPY[mode];

  return (
    <AuthCard
      title={copy.title}
      description={copy.description}
      footer={
        mode === 'sign-in' ? (
          <>
            No account?{' '}
            <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setMode('sign-up')}>
              Create one
            </button>
          </>
        ) : (
          <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setMode('sign-in')}>
            Back to sign in
          </button>
        )
      }
    >
      {!configured && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Supabase is not configured. Set <code>VITE_SUPABASE_URL_CURTIS</code> and{' '}
          <code>VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS</code>.
        </p>
      )}
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>
        {mode !== 'forgot' && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              {mode === 'sign-in' && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => setMode('forgot')}
                >
                  Forgot password?
                </button>
              )}
            </div>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              aria-invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
          </div>
        )}
        <Button type="submit" className="w-full" disabled={isSubmitting || !configured}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {copy.submit}
        </Button>
      </form>
    </AuthCard>
  );
}
