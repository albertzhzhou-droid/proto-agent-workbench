# Workbench typography

Proto and Chem share a paper-and-ink interface, with editorial headings, compact
navigation and clearly separated scientific values. Two typography profiles keep
that hierarchy consistent while preserving the user's existing local setup.

| Role | Public profile | Local Anthropic profile |
| --- | --- | --- |
| Page titles and editorial headings | Newsreader | Anthropic Serif Display |
| Reading passages | Newsreader | Anthropic Serif Text |
| Navigation, controls and utility headings | Hanken Grotesk | Anthropic Sans Text / Display |
| Code, sequences, numerical values and identifiers | Commit Mono | Anthropic Mono |

The public profile bundles fonts under the **SIL Open Font License 1.1**. They are
loaded from the application resources, without a font CDN or runtime download.
Their original family identities and license notices remain attached. The local
Anthropic profile uses the original user-supplied files, retained unchanged on
the developer's machine. Those files have no supplied redistribution license and
remain excluded from public source and binary distributions.

## Select a profile

Run the commands from `apps/proto-workbench`. Development and source builds read
`PROTO_TYPOGRAPHY_PROFILE`, which accepts `auto`, `local` or `public`.

| Selection | Behavior |
| --- | --- |
| `auto` (development/source default) | Use the complete, hash-verified local Anthropic collection when present; otherwise use the bundled public fonts. |
| `local` | Require the complete verified local collection. An incomplete collection fails instead of silently changing typography. |
| `public` | Use the bundled OFL fonts, even when local Anthropic files are available. |

```powershell
# Preserve the existing local appearance when the verified local files exist.
$env:PROTO_TYPOGRAPHY_PROFILE = 'auto'
pnpm dev

# Preview or build the public source appearance explicitly.
$env:PROTO_TYPOGRAPHY_PROFILE = 'public'
pnpm dev
# Or, after stopping the development server:
pnpm build:desktop
```

`pnpm package:win` selects the **public** profile by default, independently of
an inherited `auto` or `local` environment setting. Its packaging checks inspect
the generated renderer and Chemistry UI font assets before invoking the packager.

An explicit local-profile package is available for personal local use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-win.ps1 -TypographyProfile local
```

That explicit option includes private local fonts and does not authorize their
redistribution. Use the public default for distributable artifacts. Selecting a
profile describes the intended asset set; a successful source build alone does
not establish packaged runtime or clean-machine installation acceptance.

## Shared visual rules

Both profiles use the same font-role tokens and the same neutral light/dark
surfaces. Stable aliases (`Proto Sans Text`, `Proto Sans Display`,
`Proto Serif Text`, `Proto Serif Display` and `Proto Mono`) carry the selected
faces into CSS, canvas rendering and Monaco. These are application aliases; the
underlying font files and their original family metadata remain unchanged.
Scientific colors communicate data, while navigation and interaction remain
paper, stone and ink. New components should consume shared font tokens instead
of hard-coding a profile's family name.

Native script and generic-family fallbacks remain available for glyphs not
covered by the bundled fonts. Font substitution can change line wrapping and
column widths: verify long headings, compact menus, sequence alignment, numerical
tables and narrow viewports when changing a profile. Typography does not alter
saved scientific data, interpretation or artifact eligibility.

## Publication and provenance

The public fonts are independent projects, not redistributed Anthropic fonts.
Keep their upstream OFL texts, source revision metadata and checksums with the
assets. Preserve reserved font names and original copyright statements when
handling upstream files. The application's MIT license does not replace a
font's own license.

Local Anthropic bytes stay in the ignored local asset directory. Public output
must select its font assets explicitly, even when that directory exists in the
build workspace. Changing the public profile must not delete or modify the
user's local files. The Chemistry runtime UI is generated with the selected
profile; the imported scientific source snapshot remains immutable.

See the [public font manifest](../apps/proto-workbench/src/renderer/assets/fonts/public/manifest.json),
[upstream files and licenses](../apps/proto-workbench/src/renderer/assets/fonts/public/README.md),
[third-party notices](../apps/proto-workbench/THIRD_PARTY_NOTICES.md) and
[local font provenance](../apps/proto-workbench/src/renderer/assets/fonts/anthropic/README.md).
Historical screenshots and the [paper redesign record](workbench-paper-redesign.md)
retain the typography used when they were captured; they are not evidence that a
new public-font build has been executed or packaged.
