import { cancelScheduledJob, createAgentScheduledJob, listScheduledJobs } from '../scheduledJobs.js';
import { supabaseAsService } from '../supabaseUser.js';
import type { AgentRuntime } from './deps.js';
import { supabaseEmailReader } from './emailReader.js';
import { enqueueStep } from './enqueue.js';
import { supabaseNotificationStore } from './notificationStore.js';
import { notifyUser } from './notify.js';
import { callModelChain } from './provider.js';
import { TOOLS } from './registry.js';
import { SupabaseAgentStore } from './store.js';

export function productionRuntime(): AgentRuntime {
  const db = supabaseAsService();
  return {
    store: new SupabaseAgentStore(db),
    tools: TOOLS,
    callModel: (profile, messages, tools) => callModelChain({ profile, messages, tools }),
    enqueue: enqueueStep,
    notify: notifyUser,
    email: supabaseEmailReader(db),
    notifications: supabaseNotificationStore(db),
    schedule: {
      async schedule(input) {
        const job = await createAgentScheduledJob(
          db,
          input.userId,
          input.profileId,
          { runInMinutes: input.runInMinutes, runAt: input.runAt, cron: input.cron, prompt: input.prompt },
          input.now
        );
        return {
          id: job.id,
          prompt: job.prompt,
          displayAt: job.displayAt,
          cron: job.cron,
          timezone: job.timezone,
          status: job.status,
          profileId: job.profileId,
        };
      },
      async list(userId) {
        const jobs = await listScheduledJobs(db, userId);
        return jobs.map((job) => ({
          id: job.id,
          prompt: job.prompt,
          displayAt: job.displayAt,
          cron: job.cron,
          timezone: job.timezone,
          status: job.status,
          profileId: job.profileId,
        }));
      },
      cancel(userId, jobId) {
        return cancelScheduledJob(db, userId, jobId);
      },
    },
    now: () => new Date(),
  };
}
