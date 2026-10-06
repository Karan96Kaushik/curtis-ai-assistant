import * as z from 'zod';

export const newPasswordSchema = z
  .object({
    password: z.string().min(8, 'Use at least 8 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords don’t match' });

export type NewPasswordValues = z.infer<typeof newPasswordSchema>;
