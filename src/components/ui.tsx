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
}: {
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <section className="card rise" id={id} style={{ padding: "1rem 1.1rem" }}>
      {(title || action) && (
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "0.75rem",
            marginBottom: subtitle ? "0.25rem" : "0.75rem",
            flexWrap: "wrap",
          }}
        >
          {title && (
            <h2
              style={{
                margin: 0,
                fontSize: "0.95rem",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }}
            >
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      {subtitle && (
        <p
          style={{
            margin: "0 0 0.85rem",
            color: "var(--text-muted)",
            fontSize: "0.85rem",
          }}
        >
          {subtitle}
        </p>
      )}
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
  const base = {
    borderRadius: 10,
    padding: "0.5rem 0.9rem",
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition: "background 0.15s, border-color 0.15s",
    fontFamily: "inherit",
    // Longhand only. Mixing the `border` shorthand with a `borderColor`
    // override in the pressed state makes React warn and can drop styles.
    borderWidth: 1,
    borderStyle: "solid",
  } as const;
  const styles = {
    primary: {
      ...base,
      background: "var(--accent)",
      color: "var(--accent-contrast)",
      borderColor: "var(--accent)",
    },
    secondary: {
      ...base,
      background: "var(--surface)",
      color: "var(--text)",
      borderColor: "var(--border)",
    },
    ghost: {
      ...base,
      background: "transparent",
      color: "var(--text-muted)",
      borderColor: "transparent",
    },
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      style={{
        ...styles,
        ...(pressed
          ? {
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              borderColor: "var(--accent)",
            }
          : {}),
      }}
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
        borderRadius: 8,
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
