# Local typography assets

These original OpenType files were supplied by the user in the Anthropic Mono, Sans, and Serif fontiko archives on September 18, 2026. `manifest.json` records the archive name, original file name, OpenType family/weight, copyright metadata, and SHA-256. Font bytes are unchanged. The archive also contained a duplicate nested Mono archive; it was not copied.

The fonts identify Anthropic PBC as copyright holder. The archives contain no redistribution license; this record does not label these assets as open source or grant publication rights. The present integration is for the requested local workbench.

The `.otf` files are ignored by Git and are not included in the public repository. The tracked portion of this directory retains only provenance metadata; the user's original local files remain unchanged.

The public typography profile bundles Newsreader, Hanken Grotesk and Commit Mono under their own SIL Open Font License notices. The local Anthropic profile preserves these user-supplied fonts. Both use the same role hierarchy and native-script fallbacks; the public families are independent projects and are not renamed Anthropic assets. See the repository's [typography policy](../../../../../../../docs/typography.md) for profile selection and build commands.

Public build outputs must select the public assets explicitly rather than copying this directory's ignored binaries. Local font files must not be added to a public source or binary release without appropriate redistribution permission. A successful local build or historical screenshot does not grant publication rights for the font bytes.
