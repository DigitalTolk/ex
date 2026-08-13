import { cn } from "@/lib/utils";

/**
 * Static Cliffy mascot image (no animation/interaction). Served from
 * /public/cliffy.svg, so the SVG's internal ids stay isolated to the image —
 * safe to use anywhere alongside the animated <CliffBot/>. Use this for logos /
 * avatars (e.g. the chat header); use <CliffBot/> when you want it to react.
 */
export function CliffyMark({ className }: { className?: string }) {
  return (
    <img
      src="/cliffy.svg"
      alt="Cliffy"
      width={64}
      height={64}
      draggable={false}
      className={cn("block select-none", className)}
    />
  );
}
