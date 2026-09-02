# Proto Workbench third-party notices

This distribution includes open-source software. The visualization component
introduced for the Design Explorer is listed below. Dependency versions are
pinned in `pnpm-lock.yaml`.

## CGView.js 1.8.2

- Project: https://github.com/sciguy/cgview-js
- License: Apache License 2.0
- Author: Jason Grant

CGView.js supplies the interactive circular product map. An unmodified copy of
its Apache License 2.0 is distributed as `licenses/CGView-LICENSE.txt`.

## SVGCanvas 2.6.0

- Project: https://github.com/zenozeng/svgcanvas
- License: MIT
- Copyright: 2014 Gliffy Inc.; 2021 Zeno Zeng

SVGCanvas supplies vector export for the CGView.js scene. An unmodified copy of
its MIT license is distributed as `licenses/SVGCanvas-LICENSE.txt`.

## Sigstore JavaScript verification packages

- Projects: `@sigstore/bundle` 5.0.0, `@sigstore/protobuf-specs` 0.5.2, and `@sigstore/verify` 4.1.2
- Source: https://github.com/sigstore/sigstore-js
- License: Apache License 2.0

These verification-only packages parse Sigstore v0.3 bundles and validate
signatures against independently supplied trust material. Proto Workbench does
not bundle the high-level signing or online TUF client. An unmodified copy of
the Apache License 2.0 is distributed as `licenses/Sigstore-Apache-2.0.txt`.

## TUF JavaScript models 5.0.0 and canonical JSON 2.0.0

- Projects: `@tufjs/models` 5.0.0 and `@tufjs/canonical-json` 2.0.0
- Source: https://github.com/theupdateframework/tuf-js
- License: MIT
- Copyright: 2022 GitHub and the TUF Contributors

These packages provide canonical signed-metadata parsing and offline threshold,
version, length, hash, and expiry verification for imported trust-root candidate
packs. Proto Workbench does not import the online updater. An unmodified copy of
the MIT license is distributed as `licenses/TUF-JS-MIT.txt`.

## SeqViz 3.10.24

- Project: https://github.com/Lattice-Automation/seqviz
- License: MIT
- Copyright: 2019 Lattice Automation

MIT License

Copyright (c) 2019 Lattice Automation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
