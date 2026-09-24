# Public typography assets

This directory contains the open-source typography distributed with Proto
Workbench: **Newsreader** for serif text, **Hanken Grotesk** for interface text,
and **Commit Mono** for code and structured data. These are independent typefaces
selected for their editorial serif, restrained grotesque, and clear monospace
character. They are not Anthropic fonts or exact substitutes for those designs.

The five WOFF2 files are copied without modification from their official upstream
repositories. No subsetting, conversion, outline editing, or internal renaming
was performed. All three families are distributed under the SIL Open Font License
1.1; their exact upstream license files are included beside the fonts.

| Family | Included styles and axes | Upstream revision | License |
| --- | --- | --- | --- |
| Newsreader 1.003 | Separate upright and italic; `wght` 200–800 (default 400), `opsz` 0–72 (default 16) | [productiontype/Newsreader at cfcb4f7](https://github.com/productiontype/Newsreader/tree/cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155) | [OFL.txt](newsreader/OFL.txt) |
| Hanken Grotesk 3.014 | Separate upright and italic; `wght` 100–900 (default 400) | [marcologous/hanken-grotesk at eff37d1](https://github.com/marcologous/hanken-grotesk/tree/eff37d18946b018ad239cf5fd3992db5d19b82a0) | [OFL.txt](hanken-grotesk/OFL.txt) |
| Commit Mono 1.143 | One variable file; `wght` 200–700 (default 200), `ital` 0–1 (default 0) | [eigilnikolajsen/commit-mono at d407cd2](https://github.com/eigilnikolajsen/commit-mono/tree/d407cd2bf8e01ca1db70544052fbbb9606406c3b) | [LICENSE-FONT](commit-mono/LICENSE-FONT) |

[manifest.json](manifest.json) records every font and license file, its immutable
download URL, source commit, SHA-256 digest, and byte length. Font names, versions,
styles, and variation ranges were read from the downloaded font tables using
fontTools. The manifest records the upstream internal family `CommitMonoV143`;
the application's CSS may expose it as `Commit Mono` without changing font bytes.

These assets are bundled locally so the public build needs no font CDN or
installed fonts. The optional Anthropic assets for the owner's personal build
remain in the separate, ignored `../anthropic/` directory and are not covered by
these licenses.
