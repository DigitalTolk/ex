// Typeable clock times for the "pick a time" dialogs. People type times in
// many shapes ("9", "9:30", "930", "9am", "2.15 pm", "14:30"); parseClockTime
// accepts all of them so the field never fights the reader, and the
// suggestions list offers every half hour in the reader's own clock format.

export interface ClockTime {
  hour: number;
  minute: number;
}

const CLOCK = /^\s*(\d{1,2})(?:[:.]?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i;

export function parseClockTime(text: string): ClockTime | null {
  const m = CLOCK.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toLowerCase().replace(/\./g, '');
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

// The reader's clock format ("9:00 AM" or "09:00"), from a fixed date so no
// clock is read; hourCycle forces one style.
export function formatClockTime({ hour, minute }: ClockTime, hourCycle?: 12 | 24): string {
  return new Date(2024, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(hourCycle === undefined ? {} : { hour12: hourCycle === 12 }),
  });
}

// A quarter hour up or down from a time, wrapping around midnight.
export function stepClockTime(time: ClockTime, stepMinutes: number): ClockTime {
  const total = (time.hour * 60 + time.minute + stepMinutes + 24 * 60) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

// Every half hour of the day, for the time field's suggestions.
export function clockTimeSuggestions(): string[] {
  const out: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    out.push(formatClockTime({ hour, minute: 0 }), formatClockTime({ hour, minute: 30 }));
  }
  return out;
}

// A calendar date ("YYYY-MM-DD", as a date input gives it) and a clock time,
// combined in the browser's zone. Null when the date field is empty or not
// in the `YYYY-MM-DD` shape.
export function combineDateAndClock(date: string, time: ClockTime): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), time.hour, time.minute, 0, 0);
}

// Splits a `YYYY-MM-DDTHH:mm` seed into the two fields.
export function splitDateTimeSeed(seed: string): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(seed);
  if (!m) return { date: '', time: '' };
  return { date: m[1], time: formatClockTime({ hour: Number(m[2]), minute: Number(m[3]) }) };
}

// "in 20 min", "in 3 h", "in 1 h 15 min", "in 2 days": how far off a chosen
// time is, so the reader can sanity-check the date and time they picked.
export function describeDelay(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

// Whether a formatted time such as "1:00 PM" or "13:00" means the reader's
// clock spells out AM/PM.
export function hourCycleOf(sample: string): 12 | 24 {
  return /am|pm/i.test(sample) ? 12 : 24;
}
