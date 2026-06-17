// The surface material. `texture` is built from texture.svg (or null if disabled).
// gptdiff can retune metalness/roughness, add emissive glow, switch material type, etc.
window.GPTDIFF3D = window.GPTDIFF3D || {};
window.GPTDIFF3D.material = function (THREE, cfg, texture) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg.color || "#7c5cff"),
    metalness: cfg.metalness ?? 0.6,
    roughness: cfg.roughness ?? 0.25,
    wireframe: !!cfg.wireframe,
    emissive: new THREE.Color(cfg.emissive || "#000000"),
    emissiveIntensity: cfg.emissiveIntensity ?? 1,
  });
  if (cfg.useTexture && texture) {
    const rep = cfg.textureRepeat ?? 2;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(rep, rep);
    mat.map = texture;
  }
  return mat;
};
