const fs = require('fs');
const path = require('path');
const { CronExpressionParser } = require('cron-parser');
const { normalizeRunAt, cronOptions, formatUK, TZ } = require('../util/time');

const SCHEDULE_PATH = path.join(__dirname, '..', '..', 'context', 'schedule.json');

function readSchedule() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read schedule:', err);
    return [];
  }
}

function writeSchedule(data) {
  const dir = path.dirname(SCHEDULE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function nextCronRun(cron, fromDate = new Date()) {
  const interval = CronExpressionParser.parse(cron, cronOptions(fromDate));
  return interval.next().toDate().toISOString();
}

function addJob({ runAt, cron, prompt, targetUser = 'bayonet.baron' }) {
  const jobs = readSchedule();

  let nextRun;
  if (cron) {
    nextRun = nextCronRun(cron);
  } else {
    nextRun = normalizeRunAt(runAt);
  }

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    runAt: nextRun,
    cron: cron || null,
    timezone: TZ,
    prompt,
    targetUser,
    status: 'pending',
  };
  jobs.push(job);
  writeSchedule(jobs);
  return job;
}

function listJobs() {
  return readSchedule().filter((j) => j.status === 'pending');
}

function cancelJob(id) {
  const jobs = readSchedule();
  const job = jobs.find((j) => j.id === id);
  if (job) {
    job.status = 'cancelled';
    writeSchedule(jobs);
    return true;
  }
  return false;
}

function formatJobLine(j) {
  const when = formatUK(j.runAt);
  const kind = j.cron ? `Recurring (${j.cron}, ${TZ})` : `One-off (${TZ})`;
  return `- [${j.id}] ${kind}. Next: ${when}\n  Prompt: ${j.prompt}`;
}

// Call this from bot/client.js
function start(client, agentHandler) {
  console.log(`[scheduler] timers use timezone ${TZ}`);
  // Check every 30 seconds
  setInterval(async () => {
    const jobs = readSchedule();
    let changed = false;
    const now = new Date();

    for (const job of jobs) {
      if (job.status === 'pending' && new Date(job.runAt) <= now) {
        job.status = 'running';
        changed = true;
        writeSchedule(jobs); // Lock it quickly

        try {
          console.log(`[scheduler] Running job ${job.id} (due ${formatUK(job.runAt)}): ${job.prompt}`);
          await executeJob(client, agentHandler, job);

          if (job.cron) {
            job.runAt = nextCronRun(job.cron, new Date(now.getTime() + 1000));
            job.status = 'pending';
            console.log(`[scheduler] Next run for ${job.id}: ${formatUK(job.runAt)}`);
          } else {
            job.status = 'completed';
          }
        } catch (err) {
          console.error(`[scheduler] Job ${job.id} failed:`, err);
          job.status = 'failed';
          job.error = String(err.message || err);
        }
        changed = true;
      }
    }

    if (changed) writeSchedule(jobs);
  }, 30000);
}

async function executeJob(client, agentHandler, job) {
  // Find user
  let targetUser = client.users.cache.find((u) => u.username === job.targetUser);

  if (!targetUser) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const members = await guild.members.fetch();
        const member = members.find((m) => m.user.username === job.targetUser);
        if (member) {
          targetUser = member.user;
          break;
        }
      } catch (err) {
        console.warn(`[scheduler] failed to fetch members for guild ${guild.id}`, err.message);
      }
    }
  }

  if (!targetUser) {
    throw new Error(`User ${job.targetUser} not found in any mutual guilds.`);
  }

  const dm = await targetUser.createDM();
  const text = [
    '[SCHEDULED TASK]',
    job.prompt,
    '',
    `(System Instruction: You have woken up autonomously at ${formatUK()} to execute this scheduled task.`,
    'Read org-memory.md to determine the relevant context and what to send/not send to the user.',
    'Synthesize a message to the user with your findings and actions taken.)',
  ].join('\n');

  const reply = await agentHandler({
    text,
    discord: {
      channelId: dm.id,
      userId: targetUser.id,
      username: targetUser.username,
      displayName: targetUser.displayName,
      channelType: 1, // DM
    },
  });

  if (reply && reply !== '(No response)') {
    let remaining = reply;
    while (remaining.length > 0) {
      await dm.send(remaining.slice(0, 2000));
      remaining = remaining.slice(2000);
    }
  }
}

module.exports = { addJob, listJobs, cancelJob, start, readSchedule, formatJobLine };
