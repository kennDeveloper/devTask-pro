import { cn } from "@/lib/utils";

export const PROJECT_NAME = "DevTask Pro";
/** 1–2 uppercase letters derived from the project name. */
export const INITIALS = "DT";

export type LogoSize = "sm" | "md" | "lg";
export type LogoVariant = "mark" | "wordmark" | "lockup";

const SIZE_PX: Record<LogoSize, number> = { sm: 24, md: 40, lg: 72 };
const WORDMARK_CLASS: Record<LogoSize, string> = {
  sm: "text-[15px]",
  md: "text-[18px]",
  lg: "text-[24px]",
};

export interface LogoProps {
  size?: LogoSize;
  variant?: LogoVariant;
  className?: string;
}

/**
 * Logo — generated mark (initials on an accent square) plus wordmark.
 *
 * There is no uploaded logo asset; the mark is drawn from theme tokens so it
 * re-colours with the theme instead of shipping a baked-in PNG. If a real
 * asset lands later, swap `GeneratedMark` for a `next/image` here — the
 * `size`/`variant` surface stays the same.
 */
export function Logo({
  size = "md",
  variant = "lockup",
  className,
}: LogoProps) {
  const mark = <GeneratedMark px={SIZE_PX[size]} />;

  if (variant === "mark") {
    return <span className={cn("inline-flex shrink-0", className)}>{mark}</span>;
  }

  const wordmark = (
    <span
      className={cn(
        "font-display font-bold tracking-[-0.02em] text-ink",
        WORDMARK_CLASS[size],
      )}
    >
      {PROJECT_NAME}
    </span>
  );

  if (variant === "wordmark") {
    return (
      <span className={cn("inline-flex items-center", className)}>
        {wordmark}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {mark}
      {wordmark}
    </span>
  );
}

function GeneratedMark({ px }: { px: number }) {
  // Initials in font-display on an accent-coloured rounded square.
  const radius = Math.max(4, Math.round(px * 0.18));
  const fontSize = Math.round(px * 0.5);
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      role="img"
      aria-label={`${PROJECT_NAME} logo`}
      className="shrink-0"
    >
      <rect
        width={px}
        height={px}
        rx={radius}
        ry={radius}
        fill="var(--accent)"
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="font-display"
        fontWeight={700}
        fontSize={fontSize}
        fill="var(--accent-foreground)"
        letterSpacing="-0.02em"
      >
        {INITIALS}
      </text>
    </svg>
  );
}
