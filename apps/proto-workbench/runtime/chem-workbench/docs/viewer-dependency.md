# Vendored 3D viewer

- Package: `3dmol`, version `2.5.5`.
- Source archive: `https://registry.npmjs.org/3dmol/-/3dmol-2.5.5.tgz`.
- npm integrity: `sha512-kqNHouGqq3YfW58174tdERvm0XYTmP0tavQKOqIw1ouc2OJ7epkXEFrtEkVXV0clBZT2Ze2xHRC/qxX0u0qCdw==`.
- Archive integrity was independently verified before extraction.
- Served JS SHA-256: `f7cc78921ae72e7623e89cdd111434f58c2efddd2ffda1cd212644b406fb8016`.
- License: BSD-3-Clause, with incorporated-component notices in the upstream
  LICENSE. Both `3Dmol-LICENSE.txt` and `3Dmol-min.js.LICENSE.txt` are retained
  next to the vendored JS in `src/chem_workbench/web_assets/vendor/`.
- Upstream: [3Dmol.js](https://3dmol.org/),
  [GLViewer API](https://3dmol.org/doc/GLViewer.html).

Only the browser bundle and license files were copied into application assets;
no npm install scripts were run. Rendering uses that local copy. The runtime
does not fetch structures, scripts or data from a CDN. The viewer is not a
chemical identity, calculation or validation authority. The project uses MIT; this dependency retains its BSD-3-Clause and incorporated
component notices.
