import { createContext, useContext, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { motion, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import { ChevronsLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ImageComparison is a before/after slider, adapted from Motion Primitives'
// Image Comparison (MIT, Julien Thibeaut — the shadcn-registry component).
// Kept from it: compound parts and a motion value driving the clip paths, so
// dragging never re-renders React. Added for Ex: pointer capture (mouse, touch
// and pen in one path), a focusable keyboard-operable handle with slider
// semantics, labels that fade as the divider reaches them, and tokens only.
//
//   <ImageComparison aria-label="Real page vs mockup" style={{ aspectRatio }}>
//     <ImageComparisonImage side="after" src={mockup} alt="Mockup" />
//     <ImageComparisonImage side="before" src={real} alt="Real page" />
//     <ImageComparisonLabel side="before">Real page</ImageComparisonLabel>
//     <ImageComparisonLabel side="after">Mockup</ImageComparisonLabel>
//     <ImageComparisonHandle />
//   </ImageComparison>

interface ComparisonState {
  position: MotionValue<number>;
  value: number;
  setPosition: (next: number) => void;
  label: string;
}

const ComparisonContext = createContext<ComparisonState | null>(null);

function useComparison(): ComparisonState {
  const ctx = useContext(ComparisonContext);
  if (!ctx) throw new Error('ImageComparison parts must be rendered inside <ImageComparison>');
  return ctx;
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function ImageComparison({
  children,
  className,
  style,
  defaultPosition = 50,
  enableHover = false,
  'aria-label': label = 'Before and after',
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  defaultPosition?: number;
  // Follow the pointer without pressing (desktop hover); dragging still works.
  enableHover?: boolean;
  'aria-label'?: string;
}) {
  const position = useMotionValue(clamp(defaultPosition));
  const [value, setValue] = useState(Math.round(clamp(defaultPosition)));
  const dragging = useRef(false);

  const setPosition = (next: number) => {
    const p = clamp(next);
    position.set(p);
    setValue(Math.round(p));
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setPosition(((e.clientX - rect.left) / rect.width) * 100);
  };

  return (
    <ComparisonContext.Provider value={{ position, value, setPosition, label }}>
      <div
        data-slot="image-comparison"
        className={cn(
          'relative w-full touch-none overflow-hidden rounded-lg border bg-muted select-none',
          enableHover ? 'cursor-ew-resize' : 'cursor-col-resize',
          className,
        )}
        style={style}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current || enableHover) fromPointer(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {children}
      </div>
    </ComparisonContext.Provider>
  );
}

// The "before" image shows left of the divider, the "after" image right of it.
export function ImageComparisonImage({
  side,
  src,
  alt,
  className,
}: {
  side: 'before' | 'after';
  src: string;
  alt: string;
  className?: string;
}) {
  const { position } = useComparison();
  const clipPath = useTransform(position, (v) => (side === 'before' ? `inset(0 ${100 - v}% 0 0)` : `inset(0 0 0 ${v}%)`));
  return (
    <motion.img
      src={src}
      alt={alt}
      draggable={false}
      data-side={side}
      className={cn('pointer-events-none absolute inset-0 h-full w-full object-contain object-left-top', className)}
      style={{ clipPath }}
    />
  );
}

// A caption chip in the top corner of its side; it fades out as the divider
// covers it so it never sits on top of the other image.
export function ImageComparisonLabel({ side, children }: { side: 'before' | 'after'; children: ReactNode }) {
  const { position } = useComparison();
  const opacity = useTransform(position, side === 'before' ? [0, 18] : [82, 100], side === 'before' ? [0, 1] : [1, 0]);
  return (
    <motion.span
      aria-hidden="true"
      data-side={side}
      className={cn(
        'pointer-events-none absolute top-2.5 rounded-full border bg-background/85 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm',
        side === 'before' ? 'left-2.5' : 'right-2.5',
      )}
      style={{ opacity }}
    >
      {children}
    </motion.span>
  );
}

const STEP = 2;
const BIG_STEP = 10;

// The divider: a thin line with a round grip that is the keyboard control.
export function ImageComparisonHandle() {
  const { position, value, setPosition, label } = useComparison();
  const left = useTransform(position, (v) => `${v}%`);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const next: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowDown: value - step,
      ArrowRight: value + step,
      ArrowUp: value + step,
      PageDown: value - BIG_STEP,
      PageUp: value + BIG_STEP,
      Home: 0,
      End: 100,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    setPosition(next[e.key]);
  };
  return (
    <motion.div
      className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-background shadow-[0_0_0_1px] shadow-foreground/20"
      style={{ left }}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}% before`}
        onKeyDown={onKeyDown}
        className="pointer-events-auto absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-col-resize items-center justify-center rounded-full border bg-background text-foreground shadow-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronsLeftRight className="size-4" aria-hidden="true" />
      </div>
    </motion.div>
  );
}
