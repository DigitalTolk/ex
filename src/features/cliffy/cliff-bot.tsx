
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { CLIFF_BOT_SVG } from "./cliff-bot-markup";

/**
 * Cliff's mascot states. Each one's animation lives in the SVG's embedded
 * stylesheet, keyed off the `is-*` class on `#talkbot`. To add a new state:
 *   1. add a `#talkbot.is-<state> …` rule in /cliff-bot.html and re-extract the
 *      markup (it drives cliff-bot-markup.ts);
 *   2. add the state here + map it in STATE_CLASS.
 */
export type CliffBotState = "idle" | "near" | "over" | "curious";

const STATE_CLASS: Record<CliffBotState, string> = {
  idle: "is-away",
  near: "is-near",
  over: "is-over",
  curious: "is-curious",
};

// Eye rest positions + reference points (from the source animation).
const EYE_BASE = {
  left: { x: 45.959999084472656, y: 39.349998474121094 },
  right: { x: 108.6500015258789, y: 39.349998474121094 },
};
const CENTER = { x: 160, y: 156 };
const EYE_LINE_Y = 124;

/**
 * The animated Cliff cat. Renders the mascot SVG and drives its state.
 *
 * - Controlled: pass `state` (e.g. a future "thinking"/"success").
 * - Uncontrolled (default): eyes follow the cursor, it gets excited ("near")
 *   within `nearPx` of the cursor, and goes happy ("over") on hover.
 */
export function CliffBot({
  className,
  state,
  interactive = true,
  nearPx = 100,
  onStateChange,
}: {
  className?: string;
  state?: CliffBotState;
  interactive?: boolean;
  /** Cursor distance (px) at which the bot gets excited. */
  nearPx?: number;
  /** Fires (uncontrolled mode) whenever the live state changes — lets the host
   *  react, e.g. show a concerned phrase while the cat is "curious". */
  onStateChange?: (state: CliffBotState) => void;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  // Controlled: drive the state class directly.
  useEffect(() => {
    if (!state) return;
    const svg = hostRef.current?.querySelector("#talkbot");
    if (!svg) return;
    svg.classList.remove("is-away", "is-near", "is-over", "is-curious");
    svg.classList.add(STATE_CLASS[state]);
    svg.setAttribute("data-state", state);
  }, [state]);

  // Uncontrolled: state is driven by ACTUAL proximity every frame (not by how
  // recently the cursor moved), so excitement persists the whole time you hover
  // or stay near — it no longer dies a couple seconds after you stop moving.
  // After a long idle the cat turns "curious": it edges toward the resting
  // cursor with a "?" and a concerned look, then greets you happily when the
  // cursor moves again and settles back home.
  useEffect(() => {
    if (state || !interactive) return;
    const host0 = hostRef.current;
    const svg = host0?.querySelector<SVGSVGElement>("#talkbot");
    if (!host0 || !svg) return;
    const host = host0; // non-null binding TS keeps narrowed inside closures
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const leftEye = svg.querySelector("#leftEye");
    const rightEye = svg.querySelector("#rightEye");
    const leftPupil = svg.querySelector("#leftPupil");
    const rightPupil = svg.querySelector("#rightPupil");

    const IDLE_MS = 300_000; // cursor still this long (5 min) → curious
    const HAPPY_MS = 1_100; // happy greeting when the cursor returns
    const LEAN_MAX = 120; // max px the cat scoots toward the cursor when curious
    const EYE_FOLLOW_PX = 1200; // eyes track the cursor anywhere within this radius (≈ whole screen)

    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let raf = 0;
    let lastState = "";
    let rect = svg.getBoundingClientRect();
    let pointer: { x: number; y: number } | null = null;
    let lastMove = performance.now();
    let curious = false;
    let happyUntil = 0;

    // Curious "wander toward the cursor": the cat doesn't slide in a straight
    // line — it ambles along a curved, randomly-staggered path.
    const lean = { x: 0, y: 0 }; // applied translate (px)
    const goal = { x: 0, y: 0 }; // straight-line reach toward the cursor
    const perp = { x: 0, y: 0 }; // unit vector perpendicular to the goal (sway axis)
    let approach = 0; // 0→1 progress along the path
    let wobAmp = 0;
    let wobF1 = 0;
    let wobP1 = 0;
    let wobF2 = 0;
    let wobP2 = 0;
    const RETURN_EASE = "transform 1.1s cubic-bezier(0.22, 0.61, 0.36, 1)";

    host.style.transition = RETURN_EASE;

    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const refreshRect = () => {
      rect = svg.getBoundingClientRect();
    };

    const setState = (name: "away" | "near" | "over" | "curious") => {
      if (name === lastState) return;
      svg.classList.remove("is-away", "is-near", "is-over", "is-curious");
      svg.classList.add("is-" + name);
      svg.setAttribute("data-state", name === "away" ? "idle" : name);
      lastState = name;
      console.log(`[CliffBot] state → ${name}`);
      onStateChangeRef.current?.(name === "away" ? "idle" : name);
    };

    const toSvg = (clientX: number, clientY: number) => {
      const ctm = svg.getScreenCTM?.();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        return pt.matrixTransform(ctm.inverse());
      }
      return {
        x: ((clientX - rect.left) / rect.width) * 320,
        y: ((clientY - rect.top) / rect.height) * 320,
      };
    };

    const onMove = (evt: PointerEvent) => {
      pointer = { x: evt.clientX, y: evt.clientY };
      lastMove = performance.now();
      if (curious) {
        // Cursor came back to life — greet it happily and glide home.
        curious = false;
        happyUntil = lastMove + HAPPY_MS;
        host.style.transition = RETURN_EASE;
        host.style.transform = "";
        lean.x = 0;
        lean.y = 0;
        approach = 0;
        console.log("[CliffBot] cursor moved → happy, walking home");
      }
    };

    const forget = () => {
      pointer = null;
    };

    function tick(now: number) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = pointer ? Math.hypot(pointer.x - cx, pointer.y - cy) : Infinity;
      const overR = rect.width * 0.55;
      const idleFor = now - lastMove;
      const greeting = now < happyUntil;

      // Eyes track the cursor over a wide radius (effectively the whole screen),
      // not just when it's close; they only drift back to centre once the
      // pointer leaves the window or strays beyond the follow range.
      if (pointer && (greeting || curious || dist <= EYE_FOLLOW_PX)) {
        const p = toSvg(pointer.x, pointer.y);
        target.x = clamp((p.x - CENTER.x) / 42, -5.8, 5.8);
        target.y = clamp((p.y - EYE_LINE_Y) / 55, -4.2, 4.2);
      } else {
        target.x *= 0.94;
        target.y *= 0.94;
        if (Math.abs(target.x) < 0.03) target.x = 0;
        if (Math.abs(target.y) < 0.03) target.y = 0;
      }

      if (greeting) {
        setState("over");
      } else if (dist <= overR) {
        setState("over");
      } else if (dist <= nearPx) {
        setState("near");
      } else if (pointer && idleFor > IDLE_MS) {
        if (!curious) {
          curious = true;
          // Plan a wandering walk toward where the cursor is resting: a goal
          // vector + a perpendicular sway axis + randomized sway/stagger so no
          // two approaches look the same and none of them are a straight line.
          const d = Math.hypot(pointer.x - cx, pointer.y - cy) || 1;
          const reach = Math.min(LEAN_MAX, d * 0.55);
          goal.x = ((pointer.x - cx) / d) * reach;
          goal.y = ((pointer.y - cy) / d) * reach;
          perp.x = -(pointer.y - cy) / d;
          perp.y = (pointer.x - cx) / d;
          approach = 0;
          wobAmp = 24 + Math.random() * 30; // px of side-to-side meander
          wobF1 = 0.0026 + Math.random() * 0.0042;
          wobP1 = Math.random() * Math.PI * 2;
          wobF2 = 0.006 + Math.random() * 0.007;
          wobP2 = Math.random() * Math.PI * 2;
          host.style.transition = "none"; // JS drives the approach frame-by-frame
          console.log(
            `[CliffBot] curious after ${(idleFor / 1000).toFixed(1)}s idle → walking toward cursor`,
            { dist: Math.round(d), goal: { x: Math.round(goal.x), y: Math.round(goal.y) }, wobAmp: Math.round(wobAmp) },
          );
        }
        // Eased progress with per-frame randomness → it speeds up and dawdles
        // unevenly (random stagger), never a constant glide.
        approach = Math.min(1, approach + (1 - approach) * (0.008 + Math.random() * 0.03));
        const ease = 1 - (1 - approach) * (1 - approach);
        // Two out-of-phase sines = an organic curved path; the sway fades out as
        // it arrives so it settles on the cursor rather than orbiting it.
        const sway =
          (Math.sin(now * wobF1 + wobP1) * 0.7 + Math.sin(now * wobF2 + wobP2) * 0.3) *
          wobAmp *
          (1 - ease * 0.82);
        lean.x += (goal.x * ease + perp.x * sway - lean.x) * 0.16;
        lean.y += (goal.y * ease + perp.y * sway - lean.y) * 0.16;
        host.style.transform = `translate(${lean.x.toFixed(1)}px, ${lean.y.toFixed(1)}px)`;
        setState("curious");
      } else {
        setState("away");
      }

      current.x += (target.x - current.x) * 0.18;
      current.y += (target.y - current.y) * 0.18;

      const lx = (EYE_BASE.left.x + current.x).toFixed(3);
      const ly = (EYE_BASE.left.y + current.y).toFixed(3);
      const rx = (EYE_BASE.right.x + current.x).toFixed(3);
      const ry = (EYE_BASE.right.y + current.y).toFixed(3);
      leftEye?.setAttribute("transform", `matrix(1,0,0,1,${lx},${ly})`);
      rightEye?.setAttribute("transform", `matrix(1,0,0,1,${rx},${ry})`);

      const pupil = `translate(${(current.x * 1.38).toFixed(3)} ${(current.y * 1.38).toFixed(3)})`;
      leftPupil?.setAttribute("transform", pupil);
      rightPupil?.setAttribute("transform", pupil);

      raf = requestAnimationFrame(tick);
    }

    setState("away");
    raf = requestAnimationFrame(tick);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", forget, { passive: true });
    window.addEventListener("resize", refreshRect, { passive: true });
    window.addEventListener("scroll", refreshRect, { passive: true });
    window.addEventListener("blur", forget);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", forget);
      window.removeEventListener("resize", refreshRect);
      window.removeEventListener("scroll", refreshRect);
      window.removeEventListener("blur", forget);
      if (raf) cancelAnimationFrame(raf);
      host.style.transform = "";
    };
  }, [state, interactive, nearPx]);

  return (
    <span
      ref={hostRef}
      aria-hidden
      className={cn("block", className)}
      dangerouslySetInnerHTML={{ __html: CLIFF_BOT_SVG }}
    />
  );
}
