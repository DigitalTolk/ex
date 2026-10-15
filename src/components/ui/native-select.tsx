import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { FIELD_CLASS } from "./field-class"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  // `sm` sits in a line of text (a sentence made of fields).
  size?: "default" | "sm"
  // `ghost` has no box until hovered: a setting shown as plain text.
  variant?: "field" | "ghost"
}

// The app's <select>: a native one (the platform's own picker, which is what
// a phone should show) that looks exactly like Input — see FIELD_CLASS. The
// chevron is drawn here rather than by the browser, so it is the same in
// every engine. `className` lays the field out (width, margins); the select
// fills it.
function NativeSelect({ className, size = "default", variant = "field", ...props }: NativeSelectProps) {
  return (
    <div data-slot="native-select-wrapper" className={cn("relative min-w-0", className)}>
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          FIELD_CLASS,
          "peer cursor-pointer appearance-none pr-8 mobile:pr-10 [&_option]:bg-popover [&_option]:text-popover-foreground",
          size === "sm" && "h-7 py-0 pl-2 mobile:h-9 mobile:py-0 mobile:pl-2.5 mobile:pr-9",
          variant === "ghost" && "border-transparent bg-transparent font-medium hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50 mobile:right-3.5"
      />
    </div>
  )
}

export { NativeSelect }
