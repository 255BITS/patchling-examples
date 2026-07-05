// Lighting + animation. Add lights to `scene`, then return an update(timeSeconds, mesh)
// called every frame. patchling can add particles, post-style glow, motion, extra lights…
window.GPTDIFF3D = window.GPTDIFF3D || {};
window.GPTDIFF3D.effects = function (THREE, scene, mesh, cfg) {
  const key = new THREE.DirectionalLight(cfg.lightColor || "#ffffff", cfg.lightIntensity ?? 1.3);
  key.position.set(3, 4, 5);
  scene.add(key);

  const rim = new THREE.DirectionalLight(cfg.rimColor || "#22d3ee", 0.7);
  rim.position.set(-4, -1.5, -3);
  scene.add(rim);

  scene.add(new THREE.AmbientLight("#3a4163", 0.85));

  const speed = cfg.rotateSpeed ?? 1;
  return function update(t, obj) {
    if (cfg.autoRotate) {
      obj.rotation.y = t * 0.5 * speed;
      obj.rotation.x = Math.sin(t * 0.3) * 0.18;
    }
  };
};
