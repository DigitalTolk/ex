import { useEffect, useState } from 'react';

// startOfToday is local midnight today: the "now" for anything that only
// cares which calendar day it is.
export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// useCalendarDay is local midnight of the current day, and re-renders the
// caller when the day changes, so "Today"/"Yesterday" headings and clock-time
// labels computed from it roll over at midnight instead of freezing until the
// next data change.
export function useCalendarDay(): Date {
  const [day, setDay] = useState(startOfToday);
  useEffect(() => {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    // A second past midnight, so a timer that fires a hair early still lands
    // on the new day.
    const timer = window.setTimeout(() => setDay(startOfToday()), Math.max(0, next.getTime() - Date.now()) + 1000);
    return () => window.clearTimeout(timer);
  }, [day]);
  return day;
}
