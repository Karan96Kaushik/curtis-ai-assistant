const TZ = 'Europe/London';

/** UK local time, e.g. "Mon 20 Jul 2026, 13:30:00 BST". */
export function formatUkTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}
