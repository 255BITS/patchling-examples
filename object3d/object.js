// The geometry of the object. Return any THREE.BufferGeometry.
// gptdiff can swap the shape, change resolution, or build something custom here.
window.GPTDIFF3D = window.GPTDIFF3D || {};
window.GPTDIFF3D.geometry = function (THREE, cfg) {
  switch (cfg.shape) {
    case "box":       return new THREE.BoxGeometry(1.5, 1.5, 1.5, 4, 4, 4);
    case "sphere":    return new THREE.SphereGeometry(1.1, 64, 48);
    case "torus":     return new THREE.TorusGeometry(0.95, 0.38, 32, 96);
    case "cone":      return new THREE.ConeGeometry(1.1, 1.8, 64);
    case "icosahedron": return new THREE.IcosahedronGeometry(1.2, 0);
    case "torusKnot":
    default:          return new THREE.TorusKnotGeometry(0.85, 0.28, 220, 32);
  }
};
