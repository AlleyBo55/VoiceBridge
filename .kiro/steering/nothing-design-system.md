# Nothing Design System — UI/UX Standards

All UI in this project follows the Nothing design language: monochrome, typographic, industrial. Inspired by Swiss typography, Braun, and Teenage Engineering.

## Design Philosophy

- **Subtract, don't add.** Every element must earn its pixel. Default to removal.
- **Structure is ornament.** Expose the grid, the data, the hierarchy itself.
- **Monochrome is the canvas.** Color is an event, not a default.
- **Type does the heavy lifting.** Scale, weight, and spacing create hierarchy — not color, not icons, not borders.
- **Industrial warmth.** Technical and precise, but never cold.
- **Both modes are first-class.** Dark = OLED black instrument panel. Light = printed technical manual.

## Typography

### Font Stack (Google Fonts)

| Role | Font | Fallback | Weight |
|------|------|----------|--------|
| Display (36px+ only) | `"Doto"` | `"Space Mono", monospace` | 400–700 |
| Body / UI | `"Space Grotesk"` | `"DM Sans", system-ui, sans-serif` | 300, 400, 500, 700 |
| Data / Labels | `"Space Mono"` | `"JetBrains Mono", monospace` | 400, 700 |

### Type Scale

| Token | Size | Line Height | Letter Spacing | Use |
|-------|------|-------------|----------------|-----|
| `--display-xl` | 72px | 1.0 | -0.03em | Hero numbers |
| `--display-lg` | 48px | 1.05 | -0.02em | Section heroes, percentages |
| `--display-md` | 36px | 1.1 | -0.02em | Page titles |
| `--heading` | 24px | 1.2 | -0.01em | Section headings |
| `--subheading` | 18px | 1.3 | 0 | Subsections |
| `--body` | 16px | 1.5 | 0 | Body text |
| `--body-sm` | 14px | 1.5 | 0.01em | Secondary body |
| `--caption` | 12px | 1.4 | 0.04em | Timestamps, footnotes |
| `--label` | 11px | 1.2 | 0.08em | ALL CAPS monospace labels |

### Rules

- Doto: 36px+ ONLY, tight tracking, never for body text
- Labels: ALWAYS Space Mono, ALL CAPS, 0.06–0.1em spacing, 11–12px
- Numbers/Data: ALWAYS Space Mono. Units as `--label` size, adjacent
- Per screen max: 2 font families, 3 font sizes, 2 font weights
- Hierarchy: display (Doto) > heading (Space Grotesk) > label (Space Mono caps) > body (Space Grotesk)

## Color System

### Dark Mode (Default)

| Token | Hex | Role |
|-------|-----|------|
| `--black` | `#000000` | Primary background (OLED) |
| `--surface` | `#111111` | Elevated surfaces, cards |
| `--surface-raised` | `#1A1A1A` | Secondary elevation |
| `--border` | `#222222` | Subtle dividers |
| `--border-visible` | `#333333` | Intentional borders |
| `--text-disabled` | `#666666` | Disabled, decorative |
| `--text-secondary` | `#999999` | Labels, captions, metadata |
| `--text-primary` | `#E8E8E8` | Body text |
| `--text-display` | `#FFFFFF` | Headlines, hero numbers |

### Light Mode

| Token | Hex | Role |
|-------|-----|------|
| `--black` | `#F5F5F5` | Off-white background |
| `--surface` | `#FFFFFF` | Cards |
| `--surface-raised` | `#F0F0F0` | Secondary elevation |
| `--border` | `#E8E8E8` | Subtle dividers |
| `--border-visible` | `#CCCCCC` | Intentional borders |
| `--text-disabled` | `#999999` | Disabled |
| `--text-secondary` | `#666666` | Labels, metadata |
| `--text-primary` | `#1A1A1A` | Body text |
| `--text-display` | `#000000` | Headlines |

### Accent & Status

| Token | Hex | Usage |
|-------|-----|-------|
| `--accent` | `#D71921` | ONE per screen. Active state, destructive, urgent. Never decorative. |
| `--success` | `#4A9E5C` | Connected, good, in range |
| `--warning` | `#D4A843` | Caution, pending, degraded |
| `--error` | `#D71921` | Same as accent — errors ARE the accent |
| `--interactive` | `#5B9BF6` / `#007AFF` | Tappable text links ONLY. Not buttons. |

**Rule:** Apply status color to the VALUE, not the label or background. Labels stay `--text-secondary`.

## Spacing (8px base)

| Token | Value | Use |
|-------|-------|-----|
| `--space-xs` | 4px | Icon-to-label gaps |
| `--space-sm` | 8px | Component internal |
| `--space-md` | 16px | Standard padding, element gaps |
| `--space-lg` | 24px | Group separation |
| `--space-xl` | 32px | Section margins |
| `--space-2xl` | 48px | Major section breaks |
| `--space-3xl` | 64px | Page-level rhythm |

## Three-Layer Visual Hierarchy

Every screen has exactly THREE layers:

| Layer | What | How |
|-------|------|-----|
| Primary | ONE thing user sees first | Doto or Space Grotesk at display size, `--text-display` |
| Secondary | Supporting context | Space Grotesk body/subheading, `--text-primary` |
| Tertiary | Metadata, system info | Space Mono caption/label, `--text-secondary`, ALL CAPS |

**Test:** Squint at the screen. If two things compete, one needs to shrink or fade.

## Components

### Buttons
- Primary: pill (999px radius), `--text-display` bg, `--black` text
- Secondary: pill, transparent, `1px solid --border-visible`, `--text-primary`
- Ghost: transparent, no border, `--text-secondary`
- ALL: Space Mono 13px ALL CAPS, letter-spacing 0.06em, padding 12px 24px, min-height 44px

### Toggles
- Pill track + circle thumb
- Off: `--border-visible` track, `--text-disabled` thumb
- On: `--text-display` track, `--black` thumb
- Min touch target: 44px

### Inputs
- Underline style: `1px solid --border-visible` bottom border
- Label above: Space Mono ALL CAPS `--text-secondary`
- Focus: border → `--text-primary`
- Error: border → `--accent`
- Data fields: Space Mono for input text

### Cards
- Background: `--surface` or `--surface-raised`
- Border: `1px solid --border` or none
- Radius: 12-16px cards, 8px compact, 4px technical
- Padding: 16-24px
- NO shadows. Flat only.

### Progress Bars (Segmented)
- Discrete rectangular blocks with 2px gaps
- Square-ended, no border-radius
- Filled = status color, Empty = `--border`
- Always pair with numeric readout
- Sizes: Hero 16-20px, Standard 8-12px, Compact 4-6px height

### Icons
- Monoline, 1.5px stroke, no fill
- 24×24 base, 20×20 live area
- Round caps/joins
- Color inherits text color
- Source: Lucide (thin) or Phosphor (thin)
- NEVER filled, multi-color, or emoji

## Motion

- Duration: 150-250ms micro, 300-400ms transitions
- Easing: `cubic-bezier(0.25, 0.1, 0.25, 1)` — subtle ease-out
- Prefer opacity over position. Elements fade, don't slide.
- Hover: border/text brightens. No scale, no shadows.
- No spring, no bounce, no parallax, no scroll-jacking.

## Dot-Matrix Motif

Use for: hero typography (Doto), decorative grid backgrounds, loading indicators.

```css
.dot-grid {
  background-image: radial-gradient(circle, var(--border-visible) 1px, transparent 1px);
  background-size: 16px 16px;
}
.dot-grid-subtle {
  background-image: radial-gradient(circle, var(--border) 0.5px, transparent 0.5px);
  background-size: 12px 12px;
}
```

## Anti-Patterns (NEVER DO)

- ❌ Gradients in UI chrome
- ❌ Shadows or blur
- ❌ Skeleton loading screens → use `[LOADING...]` text or segmented spinner
- ❌ Toast popups → use inline `[SAVED]`, `[ERROR: ...]` near trigger
- ❌ Sad-face illustrations, mascots, emoji as UI
- ❌ Zebra striping in tables
- ❌ Filled or multi-color icons
- ❌ Parallax, scroll-jacking, gratuitous animation
- ❌ Spring/bounce easing
- ❌ border-radius > 16px on cards (buttons can be pill 999px)
- ❌ Color for differentiation before trying opacity/pattern first
