import { useRef, useState, type PointerEvent, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import type { ClockTime } from "@/lib/clock-time"

// ClockDial picks a time on a clock face, the way a phone's alarm clock does:
// tap or drag to the hour, and the dial turns to the minutes; tap or drag to
// those. The header reads the time back large, and its hour and minutes
// switch the dial between the two. A 12-hour clock has AM and PM beside it; a
// 24-hour one puts 13–00 on an inner ring. Mouse and finger work alike, and no
// keyboard is needed — on a phone the keyboard covered half the sheet.
interface ClockDialProps {
  value: ClockTime | null
  onChange: (time: ClockTime) => void
  hourCycle?: 12 | 24
  // Prefix for the test ids: `${testIdPrefix}-dial-hour-9`.
  testIdPrefix?: string
  className?: string
}

type Mode = "hour" | "minute"

// Positions are percentages of the face: labels sit on a ring of this radius.
const OUTER = 40
const INNER = 26

// The angle (degrees clockwise from 12 o'clock) and ring radius of a position
// on the face, from a point relative to the face's centre.
function polar(dx: number, dy: number): { angle: number; radius: number } {
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI
  return { angle: (angle + 360) % 360, radius: Math.hypot(dx, dy) }
}

// Where a label at `angle` on a ring of `radius` (% of the face) goes.
function spot(angle: number, radius: number): { left: string; top: string } {
  const rad = (angle * Math.PI) / 180
  return { left: `${50 + radius * Math.sin(rad)}%`, top: `${50 - radius * Math.cos(rad)}%` }
}

const pad = (n: number) => String(n).padStart(2, "0")

// The hour as the 12-hour face shows it.
const twelve = (hour: number) => (hour % 12 === 0 ? 12 : hour % 12)

// A 24-hour face: 1–12 outside, 13–23 and 00 inside (00 at the top).
const onInnerRing = (hour: number) => hour === 0 || hour > 12

export function ClockDial({ value, onChange, hourCycle = 12, testIdPrefix = "time", className }: ClockDialProps) {
  const [mode, setMode] = useState<Mode>("hour")
  const faceRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const pm = value !== null && value.hour >= 12

  const time = value ?? { hour: 0, minute: 0 }
  const set = (next: Partial<ClockTime>) => onChange({ ...time, ...next })

  // The hour or minute a point on the face stands for.
  const pick = (clientX: number, clientY: number) => {
    const face = faceRef.current!.getBoundingClientRect()
    const { angle, radius } = polar(clientX - face.left - face.width / 2, clientY - face.top - face.height / 2)
    if (mode === "minute") {
      set({ minute: Math.round(angle / 6) % 60 })
      return
    }
    const slot = Math.round(angle / 30) % 12 // 0 is the top
    if (hourCycle === 24) {
      const inner = radius < (face.width * (OUTER + INNER)) / 200
      set({ hour: inner ? (slot === 0 ? 0 : slot + 12) : slot === 0 ? 12 : slot })
    } else {
      set({ hour: (slot === 0 ? 0 : slot) + (pm ? 12 : 0) })
    }
  }

  const down = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    // Keep the drag when the finger slides off the face. A pointer the
    // browser no longer tracks (a synthetic one) can't be captured: the face
    // still follows it while it stays on the face.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignored, see above
    }
    pick(e.clientX, e.clientY)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) pick(e.clientX, e.clientY)
  }
  const up = () => {
    if (!dragging.current) return
    dragging.current = false
    // Hour chosen: on to the minutes, as on a phone's clock.
    if (mode === "hour") setMode("minute")
  }

  // The hand: from the centre to the chosen hour or minute.
  const hand =
    value === null
      ? null
      : mode === "minute"
        ? spot(value.minute * 6, OUTER)
        : spot((value.hour % 12) * 30, hourCycle === 24 && onInnerRing(value.hour) ? INNER : OUTER)

  const hourLabels =
    hourCycle === 24
      ? [
          ...Array.from({ length: 12 }, (_, i) => ({ hour: i === 0 ? 12 : i, label: String(i === 0 ? 12 : i), ring: OUTER })),
          ...Array.from({ length: 12 }, (_, i) => ({ hour: i === 0 ? 0 : i + 12, label: i === 0 ? "00" : String(i + 12), ring: INNER })),
        ]
      : Array.from({ length: 12 }, (_, i) => ({ hour: (i === 0 ? 0 : i) + (pm ? 12 : 0), label: String(i === 0 ? 12 : i), ring: OUTER }))

  const segment = (active: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-[32px] leading-[130%] font-bold tabular-nums transition-colors",
      active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"
    )

  return (
    <div className={cn("flex flex-col items-center gap-3", className)} data-testid={`${testIdPrefix}-dial`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Choose the hour"
          aria-pressed={mode === "hour"}
          data-testid={`${testIdPrefix}-dial-mode-hour`}
          onClick={() => setMode("hour")}
          className={segment(mode === "hour")}
        >
          {value === null ? "--" : hourCycle === 24 ? pad(value.hour) : twelve(value.hour)}
        </button>
        <span className="text-[32px] leading-[130%] font-bold text-muted-foreground">:</span>
        <button
          type="button"
          aria-label="Choose the minutes"
          aria-pressed={mode === "minute"}
          data-testid={`${testIdPrefix}-dial-mode-minute`}
          onClick={() => setMode("minute")}
          className={segment(mode === "minute")}
        >
          {value === null ? "--" : pad(value.minute)}
        </button>
        {hourCycle === 12 && (
          <div className="ml-2 flex flex-col gap-1" role="group" aria-label="AM or PM">
            {(["AM", "PM"] as const).map((half) => {
              const active = value !== null && (half === "PM") === pm
              return (
                <button
                  key={half}
                  type="button"
                  aria-pressed={active}
                  data-testid={`${testIdPrefix}-dial-${half.toLowerCase()}`}
                  onClick={() => set({ hour: (time.hour % 12) + (half === "PM" ? 12 : 0) })}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {half}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div
        ref={faceRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-testid={`${testIdPrefix}-dial-face`}
        className="relative aspect-square w-60 max-w-full touch-none select-none rounded-full bg-muted"
      >
        <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
        {hand && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-hidden="true">
            <line x1="50" y1="50" x2={parseFloat(hand.left)} y2={parseFloat(hand.top)} className="stroke-primary" strokeWidth="1" />
            <circle cx={parseFloat(hand.left)} cy={parseFloat(hand.top)} r="6" className="fill-primary/20 stroke-primary" strokeWidth="0.75" />
          </svg>
        )}
        {mode === "hour"
          ? hourLabels.map(({ hour, label, ring }) => (
              <DialLabel
                key={hour}
                at={spot(((hour % 12) * 30) % 360, ring)}
                selected={value !== null && value.hour === hour}
                small={ring === INNER}
                label={hourCycle === 24 ? `${pad(hour)} hours` : `${label} o'clock`}
                testId={`${testIdPrefix}-dial-hour-${hour}`}
                onPick={() => {
                  set({ hour })
                  setMode("minute")
                }}
              >
                {label}
              </DialLabel>
            ))
          : Array.from({ length: 12 }, (_, i) => i * 5).map((minute) => (
              <DialLabel
                key={minute}
                at={spot(minute * 6, OUTER)}
                selected={value !== null && value.minute === minute}
                label={`${minute} minutes`}
                testId={`${testIdPrefix}-dial-minute-${minute}`}
                onPick={() => set({ minute })}
              >
                {pad(minute)}
              </DialLabel>
            ))}
      </div>
    </div>
  )
}

// DialLabel is one number on the face. A pointer goes straight through it to
// the face, which picks by angle — so a drag can start anywhere, the hand's
// own tip included. It stays a button for the keyboard: Tab to it, Enter.
function DialLabel({
  at,
  selected,
  small = false,
  label,
  testId,
  onPick,
  children,
}: {
  at: { left: string; top: string }
  selected: boolean
  small?: boolean
  label: string
  testId: string
  onPick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      data-testid={testId}
      onClick={onPick}
      style={at}
      className={cn(
        "pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full tabular-nums transition-colors",
        small ? "h-8 w-8 text-xs text-muted-foreground" : "h-10 w-10 text-sm",
        selected && "bg-primary text-primary-foreground"
      )}
    >
      {children}
    </button>
  )
}
