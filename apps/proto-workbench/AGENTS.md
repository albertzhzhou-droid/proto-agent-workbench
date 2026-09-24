# Prototype Instructions

## Scientific workbench direction (September 2026)

Use a professional scientific workbench with a narrow navigation rail, collapsible task/material lists, a large central canvas, and an Inspector opened on demand. Use a warm neutral editorial identity with legible light and dark themes. The main workspace, buttons, and selection states use paper, stone, and ink; do not use fluorescent green or terracotta accents. Color belongs to meaningful scientific data encoding, not large decorative surfaces. Show actual execution state, waiting reason, loaded context, remaining task budget, recoverable checkpoints, and artifact versions. Do not use decorative progress or label an unverified response complete.

DNA edits operate on source-bound occurrences through the same atomic transaction used by the agent. Protein views use authentic deposited structures with explicit chain, model, insertion-code and missing-residue mappings. Fixtures must remain visibly identified as fixtures; native and model acceptance require real artifacts.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Workspace modes (September 2026)

Use a top-left horizontal Chat / Design / Compute switch, in that order, that changes the whole work surface. Keep functional navigation on the left and preserve each mode's working state. Use Claude and publicly documented Claude Science as layout references: restrained navigation, a central scientific artifact canvas, and contextual evidence panels. Preserve native 3D protein, DNA, and sequence views. Convey the feeling of a hardcover book through typography, spacing, warm neutral surfaces, and fine borders. Claude's terracotta logo is not a reason to color working controls terracotta.


## Chat workspace (September 19, 2026)

Chat is a full scientific workspace, with a conversation list on the left, a centered reading column, a bottom composer, and contextual documents and results. Support scientific exploration, literature, computation, code, document revision and reproducible research through real LM Studio instances. Combine OpenScience research procedures, Biomni computation and DeepSeek Harness context handling in one workflow. Use a canonical capability registry and adapt aliases to existing backend implementations; do not duplicate tools across workspaces. Show actual tool activity, saved results and availability. Keep full transcripts separate from Design run evidence. Record adapted algorithms, source commits and license attribution.

## Chemistry integration (September 19, 2026)

The first control in the top bar switches Proto CLI / Chem CLI. Preserve each workspace's live state when switching. Chem uses the same neutral paper/ink theme and Anthropic typography in light and dark modes, including scientific viewers and secondary controls. The initial source port is complete. The user now authorizes deeper chemical tools and simulation development in the integrated workspace. Keep the imported scientific snapshot immutable; add new operators in the integration layer with source attribution and current verification. Preserve the original sibling Chem workspace. XDL retains the existing isolated parser and XML/JSON roundtrip scope.

Keep the product switch at the same screen position in both editions. Reserve the upper-left sidebar area for the corresponding Proto. / Chem. wordmark. Align the Chem mode slider and navigation with Proto; omit the redundant Chemistry heading and Design, structure & evidence subtitle beneath the Chem wordmark.

Chem has the same Chat / Design / Compute modes and shared navigation component as Proto. Structure is part of Design, with a central 3D canvas and contextual source, geometry, calculation and evidence inspectors; it is not a fourth mode. Both Chat entry points use one tool registry and conversation service. Add chemical operators to that registry instead of duplicating OpenScience, Biomni or DSH capabilities. Reaction spatial views must be linked to actual calculated samples and distinguish population schematics from supplied or computed atomic trajectories.

The selected development and test baseline is LM Studio's exact `unsloth/qwen3.8-27b` catalogue key with `Q4_K_M` quantization. Do not substitute Q8, other publishers or altered model variants. A preferred model is not a connected instance: continue to discover, explicitly load, and verify the live binding.

Chem Compute includes chemistry-adapted Analysis, Statistics and Chemical Data sections alongside the reaction simulator, complete operator catalog and run history. Keep the shared Proto layout and use one canonical registry for visual and Chat execution. Preserve supplied units, sample identifiers, missing-value choices and molecular standardization policies in saved inputs and results.

Chem Compute selects tools through grouped method cards and collection tabs, matching Proto's method library, rather than a persistent vertical operator list. Opening a tool uses a shared input/output desk layout with Results, Run inputs and Provenance tabs. Preserve drafts and saved results when returning to the library.

Reaction Sim includes reaction networks and interface reactions. Interface operators share the Analysis catalog and canonical Chat registry, with preserved drafts and saved-result reopening. Keep surface coverage, areal flux, electrode current and volume concentration units distinct. Synchronize interface charts and diffusion profiles to one saved sample timeline. Surface occupancy scenes are explicitly labeled mean-field schematics, never atomistic trajectories.

Reaction Sim also groups Mechanisms, Reactors and Kinetic analysis. Reuse the shared validated network contract for CSTR, PFR, fed-batch, sensitivity, extents and uncertainty rather than building separate tool engines. Distinguish PFR residence time from startup time, open-flow balances from closed inventories, and empirical parameter quantiles from confidence intervals. Preserve seeds and every parameter draw, and keep incomplete/failed simulations explicit. Copy the authored network into a study only through the visible user action, retaining the editor draft and saved inputs.

## Icon hierarchy (September 19, 2026)

Reserve product marks for edition identity: Proto uses DNA and Chem uses the bonded-ring mark. Give Chat / Design / Compute distinct shared mode icons, and use semantic sidebar icons that differ from product, mode and method-card icons. Reserve the atom glyph for quantum calculations; do not reuse it for chemistry identity, structure, simulation, biological data or assistants. Within a method library such as Analysis, keep the same method glyph on every card, including file-input tools; do not give individual operators different icons. Repeated controls for the same identity or action keep their icon across editions and themes. Use currentColor, restrained line weights and the existing neutral surfaces, without decorative accent colors.

## Typography and live configuration (September 18, 2026)

Use the user-supplied Anthropic font assets throughout all three workspaces and every secondary menu. Sans Text is for navigation, controls and utility copy; Sans Display is for compact utility headings; Serif Display is for page titles and editorial headings; Serif Text is for reading passages; Mono is for code, sequence text, scientific values and identifiers. Preserve native script fallbacks. Selected, hovered and focused controls use neutral paper/stone/ink in both themes. Audit nested dialogs and short viewports as well as main pages.

Every current model claim must come from LM Studio Server at `http://127.0.0.1:1234`. Never seed current inventory or online/connected status from fixtures, saved MCP-era catalogs, pinned preferences or old run records. Separate reachable server, discovered model, loaded instance and explicit Workbench connection. Clear stale inventory after failures and refresh automatically while visible. Historical evidence remains historical.

The Local Models page has a horizontal Models / Design plugins & Skills switch. Display actual bundled modules and skills with enabled state, permit staged selection and an explicit Apply selection action, and wire the choice to tool exposure and new mission guidance. Core governance remains required. Changes must not silently alter an active mission. Browser previews identify their session-only settings and read-only model inventory; desktop settings persist.

## Motion and interaction (September 23, 2026)

The workbench should feel like reading a fine, well-bound paper book: elegant, quiet, and efficient. Motion is bookbinding, not animation. `src/renderer/paper-motion.css` is the single timing vocabulary for both editions and all three modes and is imported last; add new motion there rather than inventing per-view timings.

Four curves and four tempos only: entrances decelerate, state changes are symmetric, dismissals accelerate away, and displacement stays between 1px and 8px with opacity doing the rest. Animate transform and opacity so scientific canvases keep their frame budget, and resolve every entrance to `transform: none` so a finished animation leaves no containing block behind.

Hover darkens ink and press seats the control into the page. Free-standing cards lift; cells of a ruled grid, such as the method library, never lift out of their shared hairline and take a margin stroke instead. The active sidebar chapter is marked by a ribbon at the spine. Long ledger and table rows take ink only; a row that moves in a list of a thousand rows is noise.

Only genuinely running work moves on its own: spinners, the streaming caret on the message being set, the running-stage ring and the stage connector filling toward the next step. Do not animate decoration, and do not imply progress that is not being reported. Elevation is paper lifting off paper, never a coloured halo, and `prefers-reduced-motion` removes the displacement as well as the duration.
