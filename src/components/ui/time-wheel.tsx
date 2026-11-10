import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { flushSync } from "react-dom"

import { cn } from "@/lib/utils"
import { useEventCallback } from "@/hooks/useEventCallback"
import type { ClockTime } from "@/lib/clock-time"

// TimeWheel picks a time the way a phone's alarm does: a wheel each for the
// hour and the minutes, going round, and (on a 12-hour clock) a short one for
// AM/PM. The time reads as big boxed digits, "9 : 30  PM", the rows above and
// below tilting away like a drum's; a wheel that stops eases onto the row
// nearest its box.
//
// The browser does all the spinning — a finger with its momentum, a
// trackpad, a mouse wheel — and each frame it moves, the few rows on show are
// tilted to match, straight on the DOM, with no render. (A scroll-driven CSS
// animation did that lagging a fast spin, leaving the box empty for frames;
// CSS snapping, as the rendered rows moved along, made Safari throw a spin
// back to the row it had last snapped to.) A wheel is a
// long track of its values over and over, further than any fling goes, of
// which only a window of rows around where it is gets rendered: the scroll
// only moves that window along, every so many rows, so the rows ahead are
// always there and nothing re-renders row by row. When a wheel stops it takes
// its value and jumps back to the middle of its track, unseen, so it goes
// round for good. A mouse can drag a wheel too, and a tap on a row turns it
// into the box. Each wheel is a spinbutton: ↑
// steps it up and ↓ down, digits pick a value, a/p switch AM and PM, and
// Enter confirms the surrounding dialog.
interface TimeWheelProps {
  value: ClockTime | null
  onChange: (time: ClockTime) => void
  hourCycle?: 12 | 24
  // Enter on any wheel (confirms the surrounding dialog).
  onEnter?: () => void
  // Prefix for the test ids: `${testIdPrefix}-wheel-hour`, `…-hour-9`.
  testIdPrefix: string
  className?: string
}

// Each row's height, and how many rows show: the middle one is in the box.
const ROW = 48
const SHOWN = 5
const PAD = ((SHOWN - 1) / 2) * ROW
// How far a wheel that goes round runs either way from its middle, in pixels:
// further than the hardest fling, so none reaches an end.
const REACH = 20_000
// The rows rendered either side of where a wheel is, and how far it moves
// before that window moves along with it: the rows ahead of a fast spin are
// rendered long before they show.
const WINDOW = 30
const SHIFT = 10
// Where a browser has no scrollend: how long a wheel must be still before a
// spin counts as stopped.
const SETTLE_MS = 120
// Digits typed within this long add up to one value ("1", "2" → 12).
const TYPE_AHEAD_MS = 1000

const pad = (n: number) => String(n).padStart(2, "0")
const HOURS_12 = Array.from({ length: 12 }, (_, i) => String(i + 1))
const HOURS_24 = Array.from({ length: 24 }, (_, i) => pad(i))
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i))
const PERIODS = ["AM", "PM"]

export function TimeWheel({ value, onChange, hourCycle = 12, onEnter, testIdPrefix, className }: TimeWheelProps) {
  const time = value ?? { hour: 0, minute: 0 }
  const pm = time.hour >= 12
  const set = (next: Partial<ClockTime>) => onChange({ ...time, ...next })
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      onEnter?.()
      return true
    }
    if (hourCycle === 12 && (e.key === "a" || e.key === "p")) {
      e.preventDefault()
      set({ hour: (time.hour % 12) + (e.key === "p" ? 12 : 0) })
      return true
    }
    return false
  }

  return (
    <div data-testid={`${testIdPrefix}-wheel`} className={cn("flex items-center justify-center gap-1.5 select-none", className)}>
      {hourCycle === 12 ? (
        <Wheel
          label="Hour"
          values={HOURS_12}
          index={(time.hour + 11) % 12}
          onPick={(i) => set({ hour: ((i + 1) % 12) + (pm ? 12 : 0) })}
          onKey={keys}
          testId={`${testIdPrefix}-wheel-hour`}
          rowTestId={(i) => `${testIdPrefix}-wheel-hour-${i + 1}`}
        />
      ) : (
        <Wheel
          label="Hour"
          values={HOURS_24}
          index={time.hour}
          onPick={(hour) => set({ hour })}
          onKey={keys}
          testId={`${testIdPrefix}-wheel-hour`}
          rowTestId={(i) => `${testIdPrefix}-wheel-hour-${i}`}
        />
      )}
      <span aria-hidden className="text-3xl font-bold text-muted-foreground">:</span>
      <Wheel
        label="Minute"
        values={MINUTES}
        index={time.minute}
        onPick={(minute) => set({ minute })}
        onKey={keys}
        testId={`${testIdPrefix}-wheel-minute`}
        rowTestId={(i) => `${testIdPrefix}-wheel-minute-${i}`}
      />
      {hourCycle === 12 && (
        <Wheel
          label="AM or PM"
          values={PERIODS}
          index={pm ? 1 : 0}
          onPick={(i) => set({ hour: (time.hour % 12) + i * 12 })}
          onKey={keys}
          period
          testId={`${testIdPrefix}-wheel-period`}
          rowTestId={(i) => `${testIdPrefix}-wheel-${PERIODS[i].toLowerCase()}`}
        />
      )}
    </div>
  )
}

interface WheelProps {
  label: string
  values: string[]
  index: number
  onPick: (index: number) => void
  // The picker's own keys (Enter, a/p); true when it handled one.
  onKey: (e: KeyboardEvent) => boolean
  // The short AM/PM wheel: no going round, its choice in a filled pill.
  period?: boolean
  testId: string
  // The test id of a drawn row showing value `index`.
  rowTestId: (index: number) => string
}

function Wheel({ label, values, index, onPick, onKey, period = false, testId, rowTestId }: WheelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const n = values.length
  const copies = period ? 1 : 2 * Math.ceil(REACH / (n * ROW)) + 1
  const rows = n * copies
  const home = Math.floor(copies / 2) * n
  // The row the rendered window is centred on: moved along as the wheel goes.
  const [around, setAround] = useState(home + index)
  const first = Math.max(0, around - WINDOW)
  const last = Math.min(rows - 1, around + WINDOW)
  // The value this wheel last turned to itself — a change of `index` to it is
  // the wheel's own doing, not one to turn to.
  const turnedTo = useRef<number | null>(null)
  const typed = useRef({ text: "", at: 0 })
  // A mouse drag in progress: where it started, and its latest move for the
  // fling. `dragged` keeps a drag's release from also counting as a tap.
  const drag = useRef<{ y: number; top: number; at: number; v: number; moved: boolean } | null>(null)
  const dragged = useRef(false)

  const clamp = (row: number) => Math.min(rows - 1, Math.max(0, row))
  const rowAt = (el: HTMLElement) => clamp(Math.round(el.scrollTop / ROW))
  // Turns the wheel to `row`: smoothly, or at once (opening, re-homing).
  const turn = (row: number, smooth: boolean) => {
    const el = ref.current!
    el.style.scrollBehavior = smooth ? "smooth" : "auto"
    el.scrollTop = row * ROW
  }
  // The row showing value `i` nearest the box, so a step never spins far.
  const nearest = (i: number) => {
    if (period) return i
    const at = rowAt(ref.current!)
    const base = at - (at % n)
    return [base - n + i, base + i, base + n + i].reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a))
  }

  // On opening the wheel sits on its value, before it is seen.
  useLayoutEffect(() => {
    turn(home + index, false)
    turnedTo.current = index
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A new value from elsewhere (a quick pick, a key, a/p) turns the wheel.
  useEffect(() => {
    if (turnedTo.current === index) return
    turnedTo.current = index
    turn(nearest(index), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  // The one look at the wheel's value: once it has stopped. It eases onto a
  // row if it stopped between two, else takes that row's value and moves back
  // to the middle copy, unseen.
  const stopped = useEventCallback(() => {
    if (drag.current) return
    const el = ref.current!
    const row = rowAt(el)
    if (Math.abs(el.scrollTop - row * ROW) > 1) return turn(row, true)
    const i = row % n
    if (row !== home + i) {
      // Render the middle's rows before jumping there, so no frame is blank.
      flushSync(() => setAround(home + i))
      turn(home + i, false)
    }
    turnedTo.current = i
    if (i !== index) onPick(i)
  })
  useEffect(() => {
    const el = ref.current!
    const onStop = () => stopped()
    if ("onscrollend" in window) {
      el.addEventListener("scrollend", onStop)
      return () => el.removeEventListener("scrollend", onStop)
    }
    // No scrollend: the stop is the first quiet moment after the scrolling.
    let quiet: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      clearTimeout(quiet)
      quiet = setTimeout(onStop, SETTLE_MS)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      clearTimeout(quiet)
      el.removeEventListener("scroll", onScroll)
    }
  }, [stopped])

  // The drum: each row on show tilts away and fades with its distance from
  // the box — and on AM/PM, the row in the white pill turns dark as it
  // enters, not once the wheel stops (white on the white pill, it vanished
  // mid-spin) — written straight on the rows, no render.
  const drawing = useRef(0)
  const draw = () => {
    const el = ref.current!
    const at = el.scrollTop / ROW
    const top = el.children[1] as HTMLElement
    const base = Number(top.dataset.row)
    for (let row = Math.floor(at) - 3; row <= Math.ceil(at) + 3; row++) {
      const item = el.children[1 + row - base] as HTMLElement | undefined
      if (!item?.dataset.row) continue
      const d = Math.max(-3, Math.min(3, row - at))
      item.style.transform = `rotateX(${-d * 24}deg) scale(${Math.max(0.5, 1 - Math.abs(d) * 0.22)})`
      item.style.opacity = String(Math.max(0, 1 - Math.abs(d) * 0.42))
      if (period) {
        item.classList.toggle("text-background", Math.abs(d) < 0.5)
        item.classList.toggle("text-foreground", Math.abs(d) >= 0.5)
      }
    }
  }
  // Newly rendered rows get their tilt before they're seen.
  useLayoutEffect(draw)
  useEffect(() => () => cancelAnimationFrame(drawing.current), [])

  // As the wheel scrolls: redraw the drum on the next frame, and move the
  // rendered window along once it has gone SHIFT rows.
  const onScroll = () => {
    cancelAnimationFrame(drawing.current)
    drawing.current = requestAnimationFrame(draw)
    const row = rowAt(ref.current!)
    if (Math.abs(row - around) > SHIFT) setAround(row)
  }

  // A mouse drags the wheel like a finger, and a quick release flings it on a
  // few rows. Touch, trackpads and mouse wheels scroll it natively.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return
    const el = ref.current!
    el.setPointerCapture?.(e.pointerId)
    drag.current = { y: e.clientY, top: el.scrollTop, at: e.timeStamp, v: 0, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const el = ref.current!
    if (!d.moved && Math.abs(e.clientY - d.y) <= 4) return
    d.moved = true
    el.style.scrollBehavior = "auto"
    const top = d.top - (e.clientY - d.y)
    d.v = (top - el.scrollTop) / Math.max(1, e.timeStamp - d.at)
    d.at = e.timeStamp
    el.scrollTop = top
  }
  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (!d.moved) return
    // Settle where it was let go; a flick carries on about 150ms worth.
    turn(clamp(Math.round((ref.current!.scrollTop + d.v * 150) / ROW)), true)
    dragged.current = true
    setTimeout(() => (dragged.current = false))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onKey(e)) return
    const step = (d: number) => {
      e.preventDefault()
      onPick(period ? Math.min(n - 1, Math.max(0, index + d)) : (index + d + n) % n)
    }
    if (e.key === "ArrowUp") return step(1)
    if (e.key === "ArrowDown") return step(-1)
    if (!/^\d$/.test(e.key)) return
    // Digits typed close together add up ("1", "2" → 12); a value that
    // doesn't exist starts again from the last digit.
    e.preventDefault()
    const now = Date.now()
    const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key
    const match = (t: string) => values.findIndex((v) => Number(v) === Number(t))
    let i = match(text)
    typed.current = { text: i >= 0 ? text : e.key, at: now }
    if (i < 0) i = match(e.key)
    if (i >= 0) onPick(i)
  }

  return (
    // The box the chosen row sits in — a filled pill for AM/PM — ringed while
    // the wheel is in use.
    <div className={cn("group relative", period && "ml-2")}>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-xl transition-shadow group-focus-within:ring-2",
          period ? "inset-x-1 bg-foreground ring-ring" : "inset-x-0 bg-muted ring-foreground",
        )}
        style={period ? { top: PAD + 6, height: ROW - 12 } : { top: PAD, height: ROW }}
      />
      <div
        ref={ref}
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={index}
        aria-valuetext={values[index]}
        data-testid={testId}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn(
          "relative cursor-grab overflow-y-auto overscroll-contain rounded-xl outline-none [perspective:400px] [scrollbar-width:none] active:cursor-grabbing [&::-webkit-scrollbar]:hidden",
          period ? "w-16" : "w-[4.5rem]",
        )}
        style={{
          height: SHOWN * ROW,
          paddingBlock: PAD,
          // Rows fade out towards the top and bottom.
          maskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
        }}
      >
        {/* The track above and below the rendered rows, as space. */}
        <div style={{ height: first * ROW }} />
        {Array.from({ length: last - first + 1 }, (_, k) => {
          const row = first + k
          const i = row % n
          return (
            <div
              key={row}
              aria-hidden
              data-row={row}
              // On the rendered row nearest the window's middle showing each
              // value, so no id is on two rows (AM/PM has only the two).
              data-testid={period || Math.abs(row - around) <= (n - 1) / 2 ? rowTestId(i) : undefined}
              onClick={() => {
                if (dragged.current) return
                turn(row, true)
                turnedTo.current = i
                if (i !== index) onPick(i)
              }}
              className={cn(
                "flex items-center justify-center tabular-nums will-change-transform",
                period ? "text-lg font-bold" : "text-4xl font-bold text-foreground",
              )}
              style={{ height: ROW }}
            >
              {values[i]}
            </div>
          )
        })}
        <div style={{ height: (rows - 1 - last) * ROW }} />
      </div>
    </div>
  )
}
