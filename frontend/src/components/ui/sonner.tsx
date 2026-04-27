"use client"

import { useTheme } from "@/context/ThemeContext"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          // Tailwind v4 exposes design tokens as `--color-*`. The earlier
          // shadcn-cli template referenced `--popover` (no prefix), which
          // resolves to nothing here — leaving the toast transparent over
          // whatever was on screen and hard to read. Bind to the actual
          // tokens, with a hard fallback so the toast is never see-through.
          "--normal-bg": "var(--color-popover, #ffffff)",
          "--normal-text": "var(--color-popover-foreground, #000000)",
          "--normal-border": "var(--color-border, rgba(0,0,0,0.1))",
          "--border-radius": "var(--radius, 0.5rem)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast border shadow-lg backdrop-blur-none",
        },
        style: {
          background: "var(--color-popover, #ffffff)",
          color: "var(--color-popover-foreground, #000000)",
          opacity: 1,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
