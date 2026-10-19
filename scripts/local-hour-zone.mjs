#!/usr/bin/env node
// A time zone in which it is now `hour` o'clock, local time — so a test run
// can be put just before or just past midnight whenever it actually runs.
//
//   node scripts/local-hour-zone.mjs 23   → e.g. Etc/GMT-2
export function zoneWhereLocalHourIs(hour, now = new Date()) {
  let offset = (hour - now.getUTCHours() + 24) % 24;
  if (offset > 14) offset -= 24; // the Etc/GMT zones span UTC-12..UTC+14
  // POSIX-style names: Etc/GMT-14 is UTC+14.
  return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(zoneWhereLocalHourIs(Number.parseInt(process.argv[2] ?? '0', 10)));
}
