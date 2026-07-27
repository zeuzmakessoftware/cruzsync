"use client";

import type { ReactNode } from "react";

/**
 * Status presentation.
 *
 * Every status carries a glyph AND a word alongside its colour, so meaning
 * survives greyscale printing, colour vision differences, and low-quality video
 * compression during a demo recording.
 */
export type StatusTone = "good" | "warn" | "bad" | "neutral" | "demo";

const TONE_STYLE: Record<
  StatusTone,
  { bg: string; fg: string; border: string; glyph: string }
> = {
  good: {
    bg: "rgba(47,111,79,0.12)",
    fg: "var(--redwood-600)",
    border: "var(--redwood-400)",
    glyph: "●",
  },
  warn: {
    bg: "var(--sunrise-100)",
    fg: "var(--sunrise-600)",
    border: "var(--sunrise-300)",
    glyph: "▲",
  },
  bad: {
    bg: "var(--danger-100)",
    fg: "var(--danger-700)",
    border: "var(--danger-700)",
    glyph: "■",
  },
  neutral: {
    bg: "var(--surface-2)",
    fg: "var(--text-muted)",
    border: "var(--border)",
    glyph: "○",
  },
  demo: {
    bg: "rgba(34,136,189,0.14)",
    fg: "var(--pacific-700)",
    border: "var(--pacific-500)",
    glyph: "◆",
  },
};

export function Chip({
  tone = "neutral",
  children,
  title,
}: {
  tone?: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  const s = TONE_STYLE[tone];
  return (
    <span
      className="chip"
      title={title}
      style={{ background: s.bg, color: s.fg, borderColor: s.border }}
    >
      <span aria-hidden="true">{s.glyph}</span>
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  children,
  action,
  id,
  className,
}: {
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`card rise${className ? ` ${className}` : ""}`} id={id}>
      {(title || action) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </header>
      )}
      {subtitle && <p className="card-subtitle">{subtitle}</p>}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  ariaLabel,
  type = "button",
  pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  ariaLabel?: string;
  type?: "button" | "submit";
  pressed?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      className={`button button-${variant}${pressed ? " is-pressed" : ""}`}
    >
      {children}
    </button>
  );
}

export function RouteBadge({
  routeId,
  size = "md",
}: {
  routeId: string;
  size?: "sm" | "md" | "lg";
}) {
  const colors: Record<string, string> = {
    "35": "var(--pacific-700)",
    "11": "var(--sunrise-500)",
    "18": "var(--redwood-600)",
    "19": "#6b3f8f",
  };
  const dim = { sm: 26, md: 34, lg: 46 }[size];
  return (
    <span
      aria-hidden="true"
      className="tnum"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: dim,
        height: dim,
        padding: "0 0.4rem",
        borderRadius: 3,
        background: colors[routeId] ?? "var(--ink-500)",
        color: "#fff",
        fontWeight: 800,
        fontSize: size === "lg" ? "1.35rem" : size === "md" ? "1rem" : "0.8rem",
      }}
    >
      {routeId}
    </span>
  );
}

/** Renders a Tristate honestly: unknown is shown, not hidden. */
export function AmenityFact({
  label,
  value,
}: {
  label: string;
  value: boolean | "unknown";
}) {
  const tone: StatusTone =
    value === true ? "good" : value === false ? "bad" : "neutral";
  const text = value === true ? "yes" : value === false ? "no" : "unknown";
  return (
    <Chip
      tone={tone}
      title={
        value === "unknown"
          ? `${label} is not recorded in the data source. CruzSync does not guess it from the venue type.`
          : `${label}: ${text}`
      }
    >
      {label}: {text}
    </Chip>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "1.25rem",
        textAlign: "center",
        color: "var(--text-muted)",
        fontSize: "0.85rem",
        border: "1px dashed var(--border)",
        borderRadius: 10,
      }}
    >
      {children}
    </p>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}
    >
      <span className="pulse" aria-hidden="true">
        ◐{" "}
      </span>
      {label}
    </p>
  );
}
