import { useState, type ComponentType, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, Clock } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { blurActiveInput } from '@/lib/blur-input';
import { useLongPress } from '@/hooks/useLongPress';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReminderDialog, type DateTimeDialogCopy, type QuickPick } from '@/components/chat/ReminderDialog';
import { SCHEDULE_PRESETS, scheduleTimeFor } from '@/lib/schedule-times';
import { computeReminderTime, toLocalInputValue } from '@/lib/reminder-times';

// The last option in both the desktop menu and the phone popover.
const CUSTOM = { label: 'Custom time…', ariaLabel: 'Pick a custom time' };

const SCHEDULE_COPY: DateTimeDialogCopy = {
  title: 'Schedule message',
  description: 'Choose when to send this message.',
  inputLabel: 'Send time',
  confirm: 'Schedule',
  confirming: 'Scheduling…',
  failed: "Couldn't schedule the message — please try again.",
  previewVerb: 'Sends',
};

// The picker's quick picks: the menu's two mornings plus the short hops.
const SCHEDULE_QUICK_PICKS: QuickPick[] = [
  { key: 'in1h', label: 'In 1 hour', at: (now) => computeReminderTime('in1h', now) },
  { key: 'in3h', label: 'In 3 hours', at: (now) => computeReminderTime('in3h', now) },
  ...SCHEDULE_PRESETS.map((preset) => ({ key: preset.key, label: preset.label, at: (now: Date) => scheduleTimeFor(preset.key, now) })),
];

interface ScheduleSendMenuProps {
  disabled: boolean;
  // Schedules the composed message; rejects (and the composer keeps its
  // text) when scheduling fails.
  onSchedule: (sendAt: Date) => Promise<void>;
  // Tells the composer a menu is open, so a phone's toolbar stays put while
  // focus leaves the editor (like its emoji/GIF pickers).
  onOpenChange?: (open: boolean) => void;
  className?: string;
  // Phone: the Send button itself is the trigger — a tap sends (onSend), a
  // press-and-hold opens the schedule options. Without it, the trigger is
  // the small ⌄ beside Send.
  hold?: { onSend: () => void; label: string; children: ReactNode };
}

// ScheduleSendMenu is the small ⌄ beside Send (or, on a phone, a press and
// hold on Send itself): send this message later instead — tomorrow morning,
// next Monday morning, or at a custom time.
export function ScheduleSendMenu({ disabled, onSchedule, onOpenChange, className, hold }: ScheduleSendMenuProps) {
  // The custom-time dialog's seed, set when it's opened: tomorrow morning,
  // the most common pick, so the fields start somewhere useful.
  const [customSeed, setCustomSeed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  // Hold-to-open (phone), with the app's one long-press (useLongPress): a
  // press held still opens the options, a finger that moves is a scroll, and
  // the click that ends a hold is swallowed instead of also sending.
  const longPress = useLongPress({ onLongPress: () => changeOpen(true), enabled: !!hold && !disabled });
  const tapSend = () => {
    if (longPress.shouldSuppressClick()) return;
    hold?.onSend();
  };
  // The options, the same in the desktop menu and the phone popover.
  const presets = SCHEDULE_PRESETS.map((preset) => ({
    key: preset.key,
    label: preset.label,
    ariaLabel: `Send ${preset.label}`,
    pick: () => void onSchedule(scheduleTimeFor(preset.key, new Date())).catch(() => undefined),
  }));
  const openCustom = () => setCustomSeed(toLocalInputValue(scheduleTimeFor('tomorrow', new Date())));

  return (
    <>
      {hold ? (
        // Phone: a popover rather than a menu — a menu pulls focus into
        // itself, which drops the keyboard. This one never takes focus (and
        // its options keep it on press), so the keyboard stays up.
        <Popover.Root
          open={open}
          // Only the hold opens it; taps on Send (including the one that
          // ends the hold) never toggle it. Outside presses and Escape close.
          onOpenChange={(next, details) => {
            if (next || details.reason === 'trigger-press') return;
            changeOpen(false);
          }}
        >
          <Popover.Trigger
            nativeButton
            {...longPress.handlers}
            // No text-selection callout or context menu under a held finger.
            onContextMenu={(e) => e.preventDefault()}
            onClick={tapSend}
            disabled={disabled}
            aria-label={hold.label}
            aria-description="Press and hold to schedule"
            data-testid="schedule-send-hold"
            data-keeps-keyboard=""
            className={`select-none [-webkit-touch-callout:none] ${className ?? ''}`}
          >
            {hold.children}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="end" sideOffset={8} className="isolate z-50">
              <Popover.Popup
                initialFocus={false}
                finalFocus={false}
                // Pressing an option must not move focus off the editor.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                className="w-56 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
                data-testid="schedule-send-hold-menu"
                data-keeps-keyboard=""
              >
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Schedule message</div>
                {presets.map((preset) => (
                  <HoldOption
                    key={preset.key}
                    label={preset.ariaLabel}
                    icon={CalendarClock}
                    onSelect={() => {
                      changeOpen(false);
                      // Done composing: the keyboard goes down with the choice.
                      blurActiveInput();
                      preset.pick();
                    }}
                  >
                    {preset.label}
                  </HoldOption>
                ))}
                <div className="-mx-1 my-1 h-px bg-border" />
                <HoldOption
                  label={CUSTOM.ariaLabel}
                  icon={Clock}
                  onSelect={() => {
                    changeOpen(false);
                    openCustom();
                  }}
                >
                  {CUSTOM.label}
                </HoldOption>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <DropdownMenu modal={false} open={open} onOpenChange={changeOpen}>
          <DropdownMenuTrigger
            // Opened on click: the composer toolbar cancels pointerdown to keep
            // the editor focused, which also swallows the press the menu would
            // otherwise open on.
            onClick={() => changeOpen(true)}
            disabled={disabled}
            aria-label="Schedule message"
            title="Schedule for later"
            data-testid="schedule-send-trigger"
            className={className}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Schedule message</div>
            {presets.map((preset) => (
              <DropdownMenuItem key={preset.key} onClick={preset.pick} aria-label={preset.ariaLabel}>
                <CalendarClock className="mr-2 h-4 w-4" />
                {preset.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={openCustom} aria-label={CUSTOM.ariaLabel}>
              <Clock className="mr-2 h-4 w-4" />
              {CUSTOM.label}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {customSeed !== null && (
        <ReminderDialog
          open
          // No trigger: the dialog only ever asks to close.
          onOpenChange={() => setCustomSeed(null)}
          initialValue={customSeed}
          onConfirm={onSchedule}
          copy={SCHEDULE_COPY}
          quickPicks={SCHEDULE_QUICK_PICKS}
        />
      )}
    </>
  );
}

// One option in the phone's hold-to-schedule popover: a plain button, finger
// sized, styled like a menu item.
function HoldOption({
  label,
  icon: Icon,
  onSelect,
  children,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      className="flex h-11 w-full items-center rounded-md px-2 text-left text-base active:bg-accent active:text-accent-foreground"
    >
      <Icon className="mr-2 h-4 w-4" />
      {children}
    </button>
  );
}
