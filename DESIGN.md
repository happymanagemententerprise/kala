---
name: Mintfield Broadcast
description: A tactical arena game framed by deep space and pale, readable working rails.
colors:
  deep-space: "#0d2d46"
  frosted-mint: "#e6fbda"
  lemon-chiffon: "#fff8d3"
  moss-green: "#85d176"
  dusk-blue: "#3f5ba4"
  semantic-coral: "#b95f58"
typography:
  display:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "29px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Manrope, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "DM Mono, monospace"
    fontSize: "9px"
    fontWeight: 400
    letterSpacing: "1.4px"
rounded:
  xs: "5px"
  sm: "7px"
  md: "8px"
  lg: "9px"
  xl: "12px"
  modal: "14px"
spacing:
  compact: "8px"
  control: "12px"
  rail: "16px"
  column: "18px"
components:
  button-primary:
    backgroundColor: "{colors.moss-green}"
    textColor: "{colors.deep-space}"
    rounded: "{rounded.sm}"
    height: "39px"
  button-secondary:
    backgroundColor: "{colors.frosted-mint}"
    textColor: "{colors.deep-space}"
    rounded: "{rounded.sm}"
    height: "34px"
  input-room-code:
    backgroundColor: "{colors.lemon-chiffon}"
    textColor: "{colors.deep-space}"
    rounded: "{rounded.sm}"
    height: "34px"
  panel-working-rail:
    backgroundColor: "{colors.frosted-mint}"
    textColor: "{colors.deep-space}"
    rounded: "{rounded.xl}"
    padding: "16px 15px"
---

# Design System: Mintfield Broadcast

## Overview

**Creative North Star: “Mintfield Broadcast”**

Kala’s interface pairs a deep-space broadcast shell with light, practical work surfaces. The dark arena and frame hold the match in focus; pale mint and lemon rails keep roster, loadout, and controls readable. The visual voice is “Fresh, light field-guide colors; calm, precise controls.”

Display type gives match headlines and player names a condensed, high-energy voice. Manrope keeps body copy and controls fresh and readable; DM Mono is reserved for phase labels, room codes, readouts, and other measured interface data. The game keeps planned positions private until commitment, and the read-only TV view preserves that privacy. A lemon marker tracing the moss safe-zone contour once after each resolved volley makes the arena’s change legible.

**Key Characteristics:**
- Deep Space shell with light mint and lemon working rails
- Condensed display typography paired with monospaced data labels
- Clear separation between hidden planning and revealed resolution
- A single contour-tracing pulse at safe-zone transitions

## Colors

The established palette moves from a Deep Space anchor through frosted working surfaces, with moss for active/safe states and Dusk Blue for secondary information and team distinction.

### Primary
- **Moss Green**: Active safe boundary, ready states, confirmed actions, focus indicators, and primary action surfaces.

### Secondary
- **Dusk Blue**: Secondary information, active segmented controls, and the Blue team. Keep it on pale surfaces; the surface brief flags low contrast on dark grounds.

### Tertiary
- **Lemon Chiffon**: Warm contrast for the left working rail, prominent arena announcements, and the contour pulse marker.

### Neutral
- **Deep Space Blue**: Structural shell, arena ground, and dark framing.
- **Frosted Mint**: Right working rail, foreground text on dark areas, and primary light surface.

### Named Rules
**The Semantic Coral Rule.** Coral is reserved for Red team identity and critical hit or danger states; it is not a general accent.

**The Light-Rail Contrast Rule.** Dusk Blue belongs on light surfaces for secondary content. Keep dark-surface text and critical state colors distinct and readable.

## Typography

**Display Font:** Barlow Condensed (with sans-serif fallback)  
**Body/UI Font:** Manrope (with Segoe UI, sans-serif fallbacks)  
**Label/Mono Font:** DM Mono

**Character:** Barlow Condensed supplies a compact, assertive broadcast voice for headlines and names. Manrope keeps body copy and controls calm and precise, while DM Mono reserves a measured, instrument-panel quality for phase labels, room codes, readouts, and other data.

### Hierarchy
- **Display** (600, 29px, tight tracking): Arena headline; the mobile TV headline reduces to 23px.
- **Headline** (700, 35px/1): Modal titles and field-manual hierarchy.
- **Title** (600, 12–13px): Player names and control-bar action labels.
- **Body** (400, 12px/1.55): Manrope interface copy and general control text.
- **Label** (400, 8–9px, tracked, uppercase in the interface): DM Mono for phases, room codes, field readouts, and other measured/interface data.

### Named Rules
**The Role Pairing Rule.** Use Barlow Condensed for display, Manrope for body/UI and controls, and DM Mono only for measured/interface data such as phase labels, room codes, and readouts.

## Layout

The desktop shell uses three columns: match status and roster, the central arena, then room entry, loadout, weapons, and settings. The arena receives the largest share of width. The shell caps at 1760px, with a 176px minimum left rail, a 440px minimum arena, a 224px minimum right rail, and 18px gaps in the theme layer. At 1050px the columns tighten; below 780px the phone layout puts a compact room strip before a dominant arena, followed by a horizontally scrollable combatant row and secondary loadout/settings. Reset and lock actions stay fixed at the bottom within the phone safe area, and all frequent touch actions use at least 44px targets. TV mode removes player controls and expands the arena to the available screen.

The rails use 16px vertical and 15px horizontal padding at wide sizes, with tighter padding at tablet widths. Use the existing compact rhythm for dense status content and keep the arena visually dominant.

## Elevation & Depth

Depth is a hybrid of tonal layering and restrained shadows. The dark shell and arena frame establish the base; light rails and cards separate work zones by color and border. Shadows are small accents beneath the brand mark, progress, primary action, toast, and modal rather than a universal card treatment.

### Shadow Vocabulary
- **Working action lift** (`0 5px 12px #85d17644`): Primary lock action at rest.
- **Arena frame** (`0 16px 38px #061e3180`): Separates the arena from the shell.
- **Modal depth** (`0 18px 54px #051d30b3`): Gives the field manual and room dialogs clear foreground priority.

### Named Rules
**The Tonal-Zone Rule.** Use surface contrast and borders to organize the rails; reserve stronger shadow for overlays and the central arena.

## Shapes

Corners are gently rounded and compact: controls and chips mostly use 5–9px, rails and the arena frame use 12px, and modal cards use 14px. Fine borders define cards and controls. The arena clips its canvas and overlays inside the frame. The underlying polygonal safe-zone contour and corner brackets provide the recurring angular geometry against the softer interface cards.

## Components

### Buttons
- **Character:** Calm, precise Manrope controls with clear state color; reserve tracked mono for data labels.
- **Shape:** Gently rounded corners (7px for primary/room actions; 7px for the reset control).
- **Primary:** Moss Green fill, Deep Space text, 39px height; use for lock/commit and match-start actions.
- **Secondary:** Pale surface with dark ink and a fine green-gray border; room actions are 34px high.
- **Hover / Focus:** Hover shifts the fill or border toward a lighter green or Dusk Blue. Keyboard focus uses a 2px Moss Green outline with a 3px offset.
- **Disabled:** Lower opacity and remove the primary shadow; disabled actions do not read as active.

### Cards / Containers
- **Character:** Dense information cards on pale work surfaces, framed by restrained green-gray borders.
- **Corner Style:** 8–12px for cards and rails; modal cards use 14px.
- **Background:** Frosted Mint or softly tinted pale green for working cards; Lemon Chiffon for the left rail and bottom control bar.
- **Shadow Strategy:** Follow Elevation & Depth; reserve strong elevation for arena and modal.
- **Border:** Thin, low-contrast green-gray stroke.
- **Internal Padding:** Compact 8–13px in cards; rails use the spacing noted in Layout.

### Inputs / Fields
- **Style:** Lemon-tinted field, dark ink, fine green-gray border, and a joined 7px outer corner treatment where the join button meets the input.
- **Focus:** Dusk Blue border shift; the global keyboard focus state is a Moss Green outline.
- **Error / Disabled:** Coral-toned error text and reduced-opacity disabled room actions.

### Navigation

The top bar is a dark-shell utility strip with a condensed KALA wordmark, DM Mono phase status, and compact Manrope utility controls. Controls use subtle outlines by default and Moss Green emphasis on hover or active TV state. The responsive interface stacks the working sections; TV mode removes player-facing controls and keeps the arena and phase readout.

### Safe-Zone Contour Pulse

After each resolved volley, a Moss Green glow and Lemon Chiffon marker trace the safe-zone polygon once over 1,250ms. The marker follows the contour and does not reveal planned movement. The pulse is skipped when reduced motion is requested. Keep its color roles and one-pass behavior intact.

## Do's and Don'ts

### Do:
- **Do** keep the shell and arena grounded in Deep Space Blue while using the pale rails as readable working surfaces.
- **Do** use Moss Green for safe, ready, confirmed, and focused states.
- **Do** use Manrope for body copy and controls; reserve DM Mono for phase labels, room codes, readouts, and other measured/interface data.
- **Do** preserve hidden positions through planning and reveal only after all living players lock.
- **Do** honor reduced-motion preferences for the contour pulse.

### Don't:
- **Don't** use coral as a general-purpose accent; reserve it for Red team and critical/danger semantics.
- **Don't** place Dusk Blue text on dark grounds where the contrast is weak.
- **Don't** use the contour pulse to expose planned positions or aim lines.
- **Don't** replace the three-part desktop hierarchy with an equal-weight grid.
