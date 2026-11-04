import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import type { ClockTime } from "@/lib/clock-time"

// ClockDial picks a time on a clock face, the way a phone's alarm clock does:
// tap or drag to the hour, and the dial turns to the minutes; tap or drag to
// those. The time above the face is where it's typed, too — click the hour or
// the minutes and type (↑/↓ step it, a/p switch AM and PM, Enter confirms) —
// so it shows in one place only. A 12-hour clock has AM and PM beside it; a
// 24-hour one puts 13–00 on an inner ring. The hand glides to each new time
// and follows a drag exactly, settling on the value when let go.
interface ClockDialProps {
  value: ClockTime | null
  onChange: (time: ClockTime) => void
  hourCycle?: 12 | 24
  // Enter in the time above the face (confirms the surrounding dialog).
  onEnter?: () => void
  // Prefix for the test ids: `${testIdPrefix}-dial-hour-9`.
  testIdPrefix?: string
  className?: string
}

type Mode = "hour" | "minute"

// Positions are percentages of the face: labels sit on a ring of this radius.
const OUTER = 40
const INNER = 26

// The angle (degrees clockwise from 12 o'clock) and distance from the face's
// centre of a point relative to it.
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

// The hand's turn from `from` to `to` degrees the short way round, so 11 → 1
// sweeps forward past 12 rather than all the way back.
const shortestTurn = (from: number, to: number) => from + ((((to - from) % 360) + 540) % 360) - 180

export function ClockDial({ value, onChange, hourCycle = 12, onEnter, testIdPrefix = "time", className }: ClockDialProps) {
  const [mode, setMode] = useState<Mode>("hour")
  // While a pointer drags the hand: its angle, followed exactly.
  const [dragAngle, setDragAngle] = useState<number | null>(null)
  // What is being typed into the hour or the minutes, until it's left.
  const [draft, setDraft] = useState<{ mode: Mode; text: string } | null>(null)
  const faceRef = useRef<HTMLDivElement>(null)
  // Whether a pointer is down on the face — read by the pointer handlers,
  // which can run before the press's own render.
  const dragging = useRef(false)
  const minuteRef = useRef<HTMLInputElement>(null)
  const pm = value !== null && value.hour >= 12

  const time = value ?? { hour: 0, minute: 0 }
  const set = (next: Partial<ClockTime>) => onChange({ ...time, ...next })

  // The hand's angle: the drag's, else the value's. It is shown turned the
  // short way from where it was (kept from the last render, the way React
  // keeps a value derived from changing props).
  const target =
    dragAngle ?? (value === null ? null : mode === "minute" ? value.minute * 6 : (value.hour % 12) * 30)
  const [turn, setTurn] = useState(target)
  const [lastTarget, setLastTarget] = useState(target)
  if (target !== lastTarget) {
    setLastTarget(target)
    setTurn(turn === null || target === null ? target : shortestTurn(turn, target))
  }
  const handRing = mode === "hour" && hourCycle === 24 && value !== null && onInnerRing(value.hour) ? INNER : OUTER

  // The hour or minute a point on the face stands for, and the hand there.
  const pick = (clientX: number, clientY: number) => {
    const face = faceRef.current!.getBoundingClientRect()
    const { angle, radius } = polar(clientX - face.left - face.width / 2, clientY - face.top - face.height / 2)
    setDragAngle(angle)
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
    // Keep the drag when the finger slides off the face. A pointer the
    // browser no longer tracks (a synthetic one) can't be captured: the face
    // still follows it while it stays on the face.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignored, see above
    }
    dragging.current = true
    setDraft(null)
    pick(e.clientX, e.clientY)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) pick(e.clientX, e.clientY)
  }
  const up = () => {
    if (!dragging.current) return
    // Let go: the hand settles on the value, and an hour turns the dial to
    // the minutes, as on a phone's clock.
    dragging.current = false
    setDragAngle(null)
    if (mode === "hour") setMode("minute")
  }

  // Typing the hour or minutes: digits only, two at most, applied as soon as
  // they make a time. A complete hour moves on to the minutes.
  const type = (which: Mode, raw: string) => {
    const text = raw.replace(/\D/g, "").slice(0, 2)
    setDraft({ mode: which, text })
    if (text === "") return
    const n = Number(text)
    if (which === "minute") {
      if (n <= 59) set({ minute: n })
      return
    }
    if (hourCycle === 24 ? n <= 23 : n >= 1 && n <= 12) {
      set({ hour: hourCycle === 24 ? n : (n % 12) + (pm ? 12 : 0) })
    }
    if (text.length === 2 || n > (hourCycle === 24 ? 2 : 1)) minuteRef.current?.focus()
  }
  const key = (which: Mode, e: KeyboardEvent<HTMLInputElement>) => {
    const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0
    if (step !== 0) {
      e.preventDefault()
      setDraft(null)
      if (which === "hour") set({ hour: (time.hour + step + 24) % 24 })
      else set({ minute: (time.minute + step + 60) % 60 })
    } else if (hourCycle === 12 && (e.key === "a" || e.key === "p")) {
      e.preventDefault()
      set({ hour: (time.hour % 12) + (e.key === "p" ? 12 : 0) })
    } else if (e.key === "Enter") {
      onEnter?.()
    }
  }

  const shown = (which: Mode) => {
    if (draft?.mode === which) return draft.text
    if (value === null) return ""
    if (which === "minute") return pad(value.minute)
    return hourCycle === 24 ? pad(value.hour) : String(twelve(value.hour))
  }
  const segment = (which: Mode) => (
    <input
      ref={which === "minute" ? minuteRef : undefined}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={which === "hour" ? "Hour" : "Minutes"}
      title={which === "hour" ? "Type the hour" : "Type the minutes"}
      placeholder="--"
      data-testid={`${testIdPrefix}-dial-${which}-input`}
      value={shown(which)}
      onFocus={(e) => {
        setMode(which)
        e.currentTarget.select()
      }}
      // Still focused after a drag turned the face, a click turns it back.
      onClick={() => setMode(which)}
      onChange={(e) => type(which, e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => key(which, e)}
      // Reads as a field to type in: a filled box, ringed while it's the
      // part being set.
      className={cn(
        "w-[2.6ch] rounded-lg bg-muted px-1 text-center text-[32px] leading-[130%] font-bold tabular-nums caret-primary outline-none transition-[color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground",
        mode === which ? "bg-primary/10 text-foreground ring-2 ring-primary" : "text-muted-foreground hover:text-foreground"
      )}
    />
  )

  const hourLabels =
    hourCycle === 24
      ? [
          ...Array.from({ length: 12 }, (_, i) => ({ hour: i === 0 ? 12 : i, label: String(i === 0 ? 12 : i), ring: OUTER })),
          ...Array.from({ length: 12 }, (_, i) => ({ hour: i === 0 ? 0 : i + 12, label: i === 0 ? "00" : String(i + 12), ring: INNER })),
        ]
      : Array.from({ length: 12 }, (_, i) => ({ hour: (i === 0 ? 0 : i) + (pm ? 12 : 0), label: String(i === 0 ? 12 : i), ring: OUTER }))

  return (
    <div className={cn("flex flex-col items-center gap-3", className)} data-testid={`${testIdPrefix}-dial`}>
      <div className="flex items-center gap-1">
        {segment("hour")}
        <span className="text-[32px] leading-[130%] font-bold text-muted-foreground">:</span>
        {segment("minute")}
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
        className="relative aspect-square w-60 max-w-full cursor-pointer touch-none select-none rounded-full bg-muted"
      >
        {turn !== null && (
          // The hand turns as a whole about the centre: a line up from the
          // middle and a knob at its tip.
          <div
            aria-hidden="true"
            data-testid={`${testIdPrefix}-dial-hand`}
            className={cn("pointer-events-none absolute inset-0", dragAngle === null && "transition-transform duration-200 ease-out")}
            style={{ transform: `rotate(${turn}deg)` }}
          >
            <span className="absolute bottom-1/2 left-1/2 w-0.5 -translate-x-1/2 bg-primary transition-[height] duration-200" style={{ height: `${handRing}%` }} />
            <span
              className="absolute left-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-1 ring-primary transition-[top] duration-200"
              style={{ top: `${50 - handRing}%` }}
            />
          </div>
        )}
        <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
        {/* Keyed by mode: the minutes fade in over the hours. */}
        <div key={mode} className="absolute inset-0 animate-in fade-in-0 zoom-in-95 duration-200">
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
    </div>
  )
}

// DialLabel is one number on the face. A pointer goes straight through it to
// the face, which picks by angle — so a drag can start anywhere, the hand's
// own tip included. It stays a button for the keyboard: Tab to it, Enter.
// The hand's knob sits under the chosen one, so it reads light on the knob.
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
        "pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full tabular-nums transition-colors duration-200",
        small ? "h-8 w-8 text-xs text-muted-foreground" : "h-10 w-10 text-sm",
        selected && "font-semibold text-primary-foreground"
      )}
    >
      {children}
    </button>
  )
}
