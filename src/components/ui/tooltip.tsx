import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
} from "react"
import { flushSync } from "react-dom"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  // A slight open delay so tooltips (timestamps, reactions, etc.) don't
  // flash as the pointer sweeps across the message list — but short enough
  // that icon-only buttons explain themselves without a perceptible wait.
  delay = 200,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

// Lazy mounting. A message row carries several tooltips (timestamp, every
// reaction chip, status dots) and the primitive's root + trigger + content
// cost more to mount than the rest of the row; on a fast scroll that showed
// up as the largest share of each new row. So until the pointer (or keyboard
// focus) first reaches the trigger, Tooltip renders only the trigger's own
// element, and the primitive mounts on that first contact. The hover is then
// handed to the freshly mounted trigger (see TooltipTrigger), so the tooltip
// still opens from that same hover, with the usual delay.
type Handoff = "pointer" | "focus"
interface LazyTooltipContext {
  armed: boolean
  // Mount the primitive, remembering how the contact happened so the real
  // trigger can resume it; takeHandoff hands that out once.
  arm: (handoff?: Handoff) => void
  takeHandoff: () => Handoff | null
}
// Outside a Tooltip (never the case in the app) a trigger behaves as armed.
const LazyContext = createContext<LazyTooltipContext>({
  armed: true,
  /* istanbul ignore next -- only reachable for a trigger rendered outside Tooltip */
  arm: () => {},
  /* istanbul ignore next -- as above */
  takeHandoff: () => null,
})

function Tooltip({ children, ...props }: TooltipPrimitive.Root.Props) {
  // A controlled or default-open tooltip has nothing to defer.
  const [armed, setArmed] = useState(props.open !== undefined || props.defaultOpen === true)
  const handoffRef = useRef<Handoff | null>(null)
  const [ctx] = useState<LazyTooltipContext>(() => ({
    armed: false,
    arm: (handoff) => {
      handoffRef.current = handoff ?? null
      // From an event (a handoff), synchronously, so the primitive's element
      // is in place before the next event: a press that started on the inert
      // element and ended on the real one would otherwise never become a
      // click. From an effect (no handoff) React forbids flushing.
      if (handoff) flushSync(() => setArmed(true))
      else setArmed(true)
    },
    takeHandoff: () => {
      const handoff = handoffRef.current
      handoffRef.current = null
      return handoff
    },
  }))
  const value = armed === ctx.armed ? ctx : { ...ctx, armed }
  return (
    <LazyContext.Provider value={value}>
      {armed ? (
        <TooltipPrimitive.Root data-slot="tooltip" {...props}>
          {children}
        </TooltipPrimitive.Root>
      ) : (
        // Root children may be a render function (the payload API); the
        // app never uses it, and a function cannot be shown inert.
        typeof children === "function" ? null : children
      )}
    </LazyContext.Provider>
  )
}

function TooltipTrigger({ render, className, children, ...props }: TooltipPrimitive.Trigger.Props) {
  const lazy = useContext(LazyContext)
  const ref = useRef<HTMLElement | null>(null)
  // Replay the contact on the element the primitive just mounted: its
  // trigger reads the pointer type from pointerenter, listens for mouseenter
  // itself, and with the provider's delay opens only once the pointer has
  // rested after a mousemove, so send all three. Focus is simply moved back.
  // A passive effect, because the primitive attaches its listeners in its
  // own passive effect, which runs first (child before parent); and a
  // microtask from there, because an instant open flushes synchronously and
  // React refuses that from inside a lifecycle.
  useEffect(() => {
    const el = ref.current
    const handoff = lazy.takeHandoff()
    if (!el || !handoff) return
    queueMicrotask(() => {
      if (handoff === "focus") {
        el.focus()
        return
      }
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))
      el.dispatchEvent(new MouseEvent("mouseenter"))
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))
    })
  }, [lazy])
  // A render *function* cannot be cloned into an inert element: arm at once.
  const needsArming = !lazy.armed && typeof render === "function"
  useEffect(() => {
    if (needsArming) lazy.arm()
  }, [lazy, needsArming])

  if (!lazy.armed) {
    if (typeof render === "function") return null
    const el = (render ?? <button type="button" />) as ReactElement<Record<string, unknown>>
    const own = isValidElement(el) ? el.props : {}
    return cloneElement(
      el,
      {
        ...props,
        "data-slot": "tooltip-trigger",
        className: cn(own.className as string | undefined, className as string | undefined),
        onMouseEnter: (event: MouseEvent) => {
          ;(own.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(event)
          lazy.arm("pointer")
        },
        onFocus: (event: FocusEvent) => {
          ;(own.onFocus as ((e: FocusEvent) => void) | undefined)?.(event)
          lazy.arm("focus")
        },
      },
      children,
    )
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      ref={(node: HTMLElement | null) => {
        ref.current = node
      }}
      render={render}
      className={className}
      {...props}
    >
      {children}
    </TooltipPrimitive.Trigger>
  )
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const lazy = useContext(LazyContext)
  if (!lazy.armed) return null
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            // pointer-events-none so the popup (which can overlap the trigger
            // under the cursor) never swallows wheel/pointer events — scrolling
            // the page while hovering a tooltip keeps working.
            "pointer-events-none z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] border border-border bg-popover data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
