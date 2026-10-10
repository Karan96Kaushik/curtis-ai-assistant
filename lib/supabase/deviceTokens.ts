import { supabase } from '@/utils/supabase';

export type DevicePlatform = 'android' | 'ios' | 'web';

/**
 * Upsert an FCM registration token for the signed-in user.
 * The Android app should call the same upsert against Supabase directly;
 * this helper is for the web app if it ever registers a web push token.
 */
export async function upsertDeviceToken(input: {
  token: string;
  platform?: DevicePlatform;
  deviceId?: string | null;
}): Promise<void> {
  const token = input.token.trim();
  if (token.length < 32) throw new Error('Device token looks too short.');

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error('Sign in to register a device token.');

  const { error } = await supabase.from('device_tokens').upsert(
    {
      user_id: userId,
      token,
      platform: input.platform ?? 'android',
      device_id: input.deviceId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,token' }
  );
  if (error) throw error;
}

export async function deleteDeviceToken(token: string): Promise<void> {
  const { error } = await supabase.from('device_tokens').delete().eq('token', token.trim());
  if (error) throw error;
}
