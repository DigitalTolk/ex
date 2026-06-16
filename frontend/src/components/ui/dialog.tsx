import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// Primary action surfaced in the mobile dialog's top-right header (next to
// the Cancel/close), so the save/confirm control isn't stranded at the
// bottom of a full-screen sheet behind the keyboard.
interface DialogMobileAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

// Dialog bodies that own the save state in a *child* component can't pass
// `mobileAction` to DialogContent directly, so they register it through this
// context instead (see useDialogMobileAction).
const DialogMobileActionContext = React.createContext<
  ((action: DialogMobileAction | null) => void) | null
>(null)

// Register the dialog's primary action from inside a child body. The action
// renders in the mobile top-right header next to Cancel. Safe to call with a
// changing onClick each render — it's read through a ref, so the registration
// only re-runs when the label/disabled change.
export function useDialogMobileAction(action: DialogMobileAction | null) {
  const setAction = React.useContext(DialogMobileActionContext)
  const onClickRef = React.useRef(action?.onClick)
  // Keep the latest onClick in a ref (updated in an effect, never during
  // render) so the registration below only re-runs on label/disabled changes.
  React.useEffect(() => {
    onClickRef.current = action?.onClick
  })
  const label = action?.label
  const disabled = action?.disabled
  React.useEffect(() => {
    if (!setAction) return
    if (label === undefined) {
      setAction(null)
      return
    }
    setAction({ label, disabled, onClick: () => onClickRef.current?.() })
    return () => setAction(null)
  }, [setAction, label, disabled])
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  mobileCloseLabel,
  mobileAction,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  mobileCloseLabel?: string
  mobileAction?: DialogMobileAction
}) {
  const [registeredAction, setRegisteredAction] = React.useState<DialogMobileAction | null>(null)
  const effectiveAction = mobileAction ?? registeredAction
  const hasMobileBar = !!mobileCloseLabel || !!effectiveAction
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none max-md:inset-0 max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-none max-md:p-[calc(env(safe-area-inset-top)+1rem)_1rem_calc(env(safe-area-inset-bottom)+1rem)] sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          hasMobileBar && "max-md:[&_[data-slot=dialog-header]]:pr-20",
          mobileCloseLabel && effectiveAction && "max-md:[&_[data-slot=dialog-header]]:pr-40",
          className
        )}
        {...props}
      >
        <DialogMobileActionContext.Provider value={setRegisteredAction}>
          {children}
        </DialogMobileActionContext.Provider>
        {showCloseButton && (
          <>
            {hasMobileBar && (
              <div
                data-slot="dialog-mobile-actions"
                className="absolute right-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-10 hidden items-center gap-1 max-md:flex"
              >
                {mobileCloseLabel && (
                  <DialogPrimitive.Close
                    data-slot="dialog-mobile-close"
                    render={
                      <Button
                        aria-label={mobileCloseLabel}
                        variant="ghost"
                        className="h-9 px-3 text-base after:content-[var(--mobile-close-label)]"
                        style={{
                          '--mobile-close-label': `"${mobileCloseLabel}"`,
                        } as React.CSSProperties}
                      />
                    }
                  />
                )}
                {effectiveAction && (
                  <Button
                    data-slot="dialog-mobile-action"
                    type="button"
                    className="h-9 px-3 text-base"
                    onClick={effectiveAction.onClick}
                    disabled={effectiveAction.disabled}
                  >
                    {effectiveAction.label}
                  </Button>
                )}
              </div>
            )}
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  variant="ghost"
                  className={cn("absolute top-2 right-2", hasMobileBar && "max-md:hidden")}
                  size="icon-sm"
                />
              }
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:text-link *:[a]:transition-colors *:[a]:hover:text-link/80",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
