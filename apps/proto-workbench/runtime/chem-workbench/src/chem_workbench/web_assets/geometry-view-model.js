/* Numerical views preserve the server's stored values; rendering never supplies coordinates. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChemGeometryView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(finite);
  const numericText = value => Object.is(value, -0) ? '-0' : String(value);
  function stringify(value) {
    if(typeof value === 'number') {if(!finite(value))throw Error('Non-finite export value.');return numericText(value);}
    if(value === null || typeof value !== 'object')return JSON.stringify(value);
    if(Array.isArray(value))return '['+value.map(item=>stringify(item)??'null').join(',')+']';
    return '{'+Object.entries(value).filter(([,item])=>item!==undefined).map(([key,item])=>JSON.stringify(key)+':'+stringify(item)).join(',')+'}';
  }
  function validate(geometry, scale = 1) {
    if (!geometry || geometry.units !== 'angstrom' || !finite(scale) || scale <= 0)
      throw Error('An angstrom geometry and a finite positive display scale are required.');
    if (!Array.isArray(geometry.atoms) || !geometry.atoms.length ||
        !geometry.atoms.every(atom => typeof atom.element === 'string' && vector(atom.position)))
      throw Error('Every atom requires three finite recorded coordinates.');
    if(geometry.atoms.length>256)throw Error('3D preview supports up to 256 recorded atoms. The complete study remains available in its evidence export.');
    if(geometry.display_repeats!=null && ![1,2].includes(geometry.display_repeats))
      throw Error('3D cell preview requires one or two declared display repeats per axis.');
    if (geometry.cell != null && (!Array.isArray(geometry.cell) || geometry.cell.length !== 3 || !geometry.cell.every(vector)))
      throw Error('The recorded cell must contain three finite Cartesian vectors.');
    if (!Array.isArray(geometry.bonds) || geometry.bonds.length>1024 || geometry.bonds.some(bond =>
      !Number.isInteger(bond.a) || !Number.isInteger(bond.b) || bond.a < 0 || bond.b < 0 ||
      bond.a >= geometry.atoms.length || bond.b >= geometry.atoms.length || bond.a === bond.b ||
      !finite(bond.order) || bond.order <= 0)) throw Error('The recorded bond list is invalid.');
    if (geometry.atoms.some(atom => atom.position.some(value => !Number.isFinite(value * scale))) ||
        geometry.cell?.some(row => row.some(value => !Number.isFinite(value * scale))))
      throw Error('The display transform exceeds the numeric range.');
    return geometry;
  }
  function rows(geometry, scale = 1) {
    validate(geometry, scale);
    return geometry.atoms.map((atom, index) => ({
      index, id: atom.id ?? String(index + 1), element: atom.element,
      position: [...atom.position], displayed_position: atom.position.map(value => value * scale),
      oxidation_state: atom.oxidation_state ?? null, sublattice: atom.sublattice ?? null
    }));
  }
  function distance(geometry, first, second, scale = 1) {
    validate(geometry, scale);
    if (![first, second].every(index => Number.isInteger(index) && index >= 0 && index < geometry.atoms.length))
      throw Error('Select two recorded atoms.');
    const a = geometry.atoms[first].position, b = geometry.atoms[second].position;
    return Math.hypot(...a.map((value, axis) => value * scale - b[axis] * scale));
  }
  function csv(geometry, scale = 1) {
    const quote = value => {
      let text = numericText(value ?? '');
      if(typeof value === 'string' && (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)))text="'"+text;
      return '"'+text.replaceAll('"','""')+'"';
    };
    const header = ['atom_id', 'element', 'base_x_A', 'base_y_A', 'base_z_A', 'display_x_A', 'display_y_A', 'display_z_A', 'oxidation_state', 'sublattice'];
    return [header, ...rows(geometry, scale).map(atom => [atom.id, atom.element, ...atom.position, ...atom.displayed_position, atom.oxidation_state, atom.sublattice])]
      .map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
  }
  return { validate, rows, distance, csv, numericText, stringify };
});
