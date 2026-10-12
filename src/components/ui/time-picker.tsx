import { useEffect, useMemo, useRef } from "react"

import { cn } from "@/lib/utils"
import { formatClockTime, type ClockTime } from "@/lib/clock-time"

// TimePicker is one scrolling list of times, every quarter hour, the way
// calendar apps offer them: tap one and you are done, no hour/minute/AM-PM
// juggling. It keeps the chosen time's row in view, and when the typed time
// falls between two rows it scrolls to the nearest one without highlighting
// either, so an odd minute is never silently rounded.
interface TimePickerProps {
  value: ClockTime | null
  onChange: (time: ClockTime) => void
  hourCycle?: 12 | 24
  stepMinutes?: number
  className?: string
  // Prefix for the row test ids: `${testIdPrefix}-slot-14-30`.
  testIdPrefix?: string
}

export function timeSlots(stepMinutes: number): ClockTime[] {
  const slots: ClockTime[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += stepMinutes) {
    slots.push({ hour: Math.floor(minutes / 60), minute: minutes % 60 })
  }
  return slots
}

const minutesOf = (t: ClockTime) => t.hour * 60 + t.minute

export function TimePicker({ value, onChange, hourCycle = 12, stepMinutes = 15, className, testIdPrefix = "time" }: TimePickerProps) {
  const slots = useMemo(() => timeSlots(stepMinutes), [stepMinutes])
  const selected = value === null ? -1 : slots.findIndex((s) => s.hour === value.hour && s.minute === value.minute)
  // The row to keep in view: the exact one, else the last one at or before.
  const nearest = value === null ? -1 : selected >= 0 ? selected : Math.floor(minutesOf(value) / stepMinutes)

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[nearest] as HTMLElement | undefined
    if (!list || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    // Scrolled by hand within the list only: scrollIntoView would also move
    // every scrolling ancestor, and on a phone that yanked the dialog.
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2
    }
  }, [nearest])

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Times"
      className={cn("relative flex flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1", className)}
    >
      {slots.map((slot, i) => (
        <button
          key={minutesOf(slot)}
          type="button"
          role="option"
          aria-selected={i === selected}
          data-testid={`${testIdPrefix}-slot-${slot.hour}-${slot.minute}`}
          onClick={() => onChange(slot)}
          className={cn(
            "shrink-0 rounded-md px-3 py-1.5 text-left text-sm tabular-nums transition-colors hover:bg-muted mobile:py-2",
            i === selected && "bg-primary text-primary-foreground hover:bg-primary",
            i === nearest && i !== selected && "bg-muted"
          )}
        >
          {formatClockTime(slot, hourCycle)}
        </button>
      ))}
    </div>
  )
}
