import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export type WorkspaceModelTheme = "light" | "dark";
export type WorkspaceThreeModel = {
  group: THREE.Group;
  update(timeSeconds: number, state: string, reduced: boolean): void;
  setTheme(theme: WorkspaceModelTheme): void;
};

const isWorking = (state: string) =>
  ["working", "thinking", "connecting", "processing"].includes(state);

function tube(
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
) {
  return new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points),
      80,
      radius,
      6,
      false,
    ),
    material,
  );
}
function roundBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  material: THREE.Material,
) {
  return new THREE.Mesh(
    new RoundedBoxGeometry(width, height, depth, 4, radius),
    material,
  );
}

const shellVertex = `
  varying vec3 vNormalView;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const shellFragment = `
  uniform vec3 uTint;
  uniform float uStrength;
  varying vec3 vNormalView;
  varying vec3 vView;
  void main() {
    float facing = max(0.0, dot(normalize(vNormalView), normalize(vView)));
    float rim = pow(1.0 - facing, 3.3);
    float softRim = pow(1.0 - facing, 1.6);
    float alpha = (rim * 0.82 + softRim * 0.12 + 0.004) * uStrength;
    gl_FragColor = vec4(uTint * (0.9 + rim * 0.18), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Perspective-aware masking keeps all decorative arcs clear of the resident's face.
const arcVertex = `
  varying vec3 vPositionView;
  varying vec3 vCenterView;
  varying float vModelScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPositionView = mv.xyz;
    vCenterView = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vModelScale = length(modelViewMatrix[0].xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const arcFragment = `
  uniform vec3 uTint;
  uniform float uStrength;
  varying vec3 vPositionView;
  varying vec3 vCenterView;
  varying float vModelScale;
  void main() {
    vec2 p = vPositionView.xy / max(1.0, -vPositionView.z);
    vec2 center = vCenterView.xy / max(1.0, -vCenterView.z);
    float distanceFromResident = length(p - center) * max(1.0, -vCenterView.z);
    float clearFace = smoothstep(76.0 * vModelScale, 96.0 * vModelScale, distanceFromResident);
    gl_FragColor = vec4(uTint, uStrength * clearFace);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A quiet volumetric energy shell, with just two sparse arcs and no wire cage. */
export function createNestModel(): WorkspaceThreeModel {
  const group = new THREE.Group();
  group.name = "xuti-spherical-nest";
  const shellMaterial = new THREE.ShaderMaterial({
    vertexShader: shellVertex,
    fragmentShader: shellFragment,
    uniforms: {
      uTint: { value: new THREE.Color(0x5c87d9) },
      uStrength: { value: 0.3 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const outerMaterial = shellMaterial.clone();
  outerMaterial.uniforms.uStrength.value = 0.08;
  const sphere = new THREE.SphereGeometry(145, 64, 40);
  const shell = new THREE.Mesh(sphere, shellMaterial),
    haze = new THREE.Mesh(sphere, outerMaterial);
  haze.scale.setScalar(1.035);
  group.add(shell, haze);

  const arcMaterial = new THREE.ShaderMaterial({
    vertexShader: arcVertex,
    fragmentShader: arcFragment,
    uniforms: {
      uTint: { value: new THREE.Color(0x74b9f3) },
      uStrength: { value: 0.55 },
    },
    transparent: true,
    depthWrite: false,
  });
  const secondaryMaterial = arcMaterial.clone();
  secondaryMaterial.uniforms.uTint.value.setHex(0x617dab);
  const currents = new THREE.Group();
  group.add(currents);
  for (const [index, path] of [
    {
      start: -0.15,
      length: Math.PI * 0.8,
      x: 0.42,
      y: -0.3,
      z: 0.55,
      radius: 149,
    },
    {
      start: Math.PI * 0.6,
      length: Math.PI * 0.62,
      x: -0.62,
      y: 0.75,
      z: -0.25,
      radius: 147,
    },
  ].entries()) {
    const orbit = new THREE.Group(),
      material = index === 0 ? arcMaterial : secondaryMaterial;
    orbit.rotation.set(path.x, path.y, path.z);
    const points = Array.from({ length: 41 }, (_, i) => {
      const a = path.start + (path.length * i) / 40;
      return new THREE.Vector3(
        Math.cos(a) * path.radius,
        Math.sin(a) * path.radius,
        0,
      );
    });
    orbit.add(tube(points, index === 0 ? 0.68 : 0.45, material));
    const point = points[points.length - 1];
    // Geometry translation keeps each mesh's local origin at the sphere center for the mask.
    const node = new THREE.Mesh(
      new THREE.SphereGeometry(index === 0 ? 1.7 : 1.2, 12, 8).translate(
        point.x,
        point.y,
        point.z,
      ),
      material,
    );
    orbit.add(node);
    currents.add(orbit);
  }
  let light = false,
    palette = "";
  const setTheme = (theme: WorkspaceModelTheme) => {
    light = theme === "light";
    shellMaterial.uniforms.uTint.value.setHex(light ? 0x456bb0 : 0x5c87d9);
    outerMaterial.uniforms.uTint.value.setHex(light ? 0x5375b1 : 0x466eac);
    palette = "";
  };
  const update = (time: number, state: string, reduced: boolean) => {
    const muted = state === "muted",
      still = reduced || muted,
      warning = state === "error",
      notice = state === "notice";
    const t = still ? 0 : time,
      active =
        isWorking(state) || state === "listening" || state === "speaking";
    const breath = still ? 0.5 : (Math.sin(t * (active ? 1.25 : 0.65)) + 1) / 2;
    const nextPalette = `${light}:${warning}:${muted}`;
    if (palette !== nextPalette) {
      palette = nextPalette;
      arcMaterial.uniforms.uTint.value.setHex(
        warning ? 0xcba575 : muted ? 0x647b9a : light ? 0x3c739e : 0x74b9f3,
      );
      secondaryMaterial.uniforms.uTint.value.setHex(
        light ? 0x637ba9 : 0x617dab,
      );
    }
    shellMaterial.uniforms.uStrength.value =
      (light ? 0.18 : 0.29) + breath * 0.08;
    outerMaterial.uniforms.uStrength.value =
      (light ? 0.04 : 0.055) + breath * 0.025;
    arcMaterial.uniforms.uStrength.value = muted
      ? 0.28
      : warning
        ? 0.6
        : 0.5 + breath * 0.15;
    secondaryMaterial.uniforms.uStrength.value = 0.3 + breath * 0.1;
    if (notice)
      arcMaterial.uniforms.uStrength.value +=
        (still ? 0.5 : (Math.sin(t * 1.8) + 1) / 2) * 0.09;
    currents.rotation.y = still ? 0 : t * (active ? 0.075 : 0.027);
    currents.rotation.z = still ? 0 : Math.sin(t * 0.18) * 0.035;
    haze.scale.setScalar(1.035 + (still ? 0 : Math.sin(t * 0.65) * 0.006));
    shell.rotation.z = !still && t % 11 > 10.2 ? Math.sin(t * 30) * 0.0006 : 0;
  };
  setTheme("dark");
  update(0, "idle", true);
  return { group, update, setTheme };
}

/** A floating rounded companion: continuous blue shells, glass visor and small free hands. */
export function createRobotModel(): WorkspaceThreeModel {
  const group = new THREE.Group();
  group.name = "xuti-robot";
  const body = new THREE.Group(),
    head = new THREE.Group();
  body.position.y = -4;
  head.position.y = 18;
  group.add(body);
  body.add(head);
  const shell = new THREE.MeshStandardMaterial({
    color: 0x425b91,
    roughness: 0.34,
    metalness: 0.32,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: 0x6a84b1,
    roughness: 0.32,
    metalness: 0.58,
  });
  const inset = new THREE.MeshStandardMaterial({
    color: 0x223754,
    roughness: 0.45,
    metalness: 0.35,
  });
  const visor = new THREE.MeshStandardMaterial({
    color: 0x061224,
    roughness: 0.18,
    metalness: 0.18,
  });
  const eyeLight = new THREE.MeshBasicMaterial({ color: 0x9bc5e2 });
  const signal = new THREE.MeshStandardMaterial({
    color: 0x8cb2d5,
    emissive: 0x3c6e9b,
    emissiveIntensity: 0.35,
    roughness: 0.32,
    metalness: 0.2,
  });
  const signalGlow = new THREE.MeshBasicMaterial({
    color: 0x6993be,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });

  head.add(roundBox(110, 72, 64, 29, shell));
  const bezel = roundBox(97, 57, 38, 18.5, edge);
  bezel.scale.z = 0.13;
  bezel.position.set(0, -2, 31);
  head.add(bezel);
  const face = roundBox(92, 52, 36, 17.5, visor);
  face.scale.z = 0.12;
  face.position.set(0, -2, 33);
  head.add(face);
  const eyes = new THREE.Group();
  eyes.position.set(0, 2.5, 35.5);
  const eyeGeometry = new THREE.CapsuleGeometry(3.3, 5.5, 5, 12);
  for (const x of [-21, 21]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeLight);
    eye.position.x = x;
    eye.scale.z = 0.3;
    eyes.add(eye);
  }
  head.add(eyes);
  const smile = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-8, -11, 35.6),
        new THREE.Vector3(0, -17, 36),
        new THREE.Vector3(8, -11, 35.6),
      ),
      24,
      0.95,
      7,
      false,
    ),
    eyeLight,
  );
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(4.2, 0.95, 8, 24),
    eyeLight,
  );
  mouth.position.set(0, -12, 35.8);
  mouth.visible = false;
  head.add(smile, mouth);

  const earGeometry = new THREE.SphereGeometry(1, 20, 16);
  for (const sign of [-1, 1]) {
    const ear = new THREE.Mesh(earGeometry, inset);
    ear.scale.set(4.3, 11.5, 8.7);
    ear.position.set(sign * 54.5, -1, -2);
    const port = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 4.5, 0.9, 20),
      signal,
    );
    port.rotation.z = Math.PI / 2;
    port.position.set(sign * 58.4, -1, -2);
    head.add(ear, port);
  }
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(1.25, 1.7, 14, 12),
    edge,
  );
  antenna.position.set(0, 42, -2);
  const antennaTip = new THREE.Mesh(
    new THREE.SphereGeometry(3.5, 20, 14),
    signal,
  );
  antennaTip.position.set(0, 52, -2);
  const tipGlow = new THREE.Mesh(
    new THREE.SphereGeometry(5, 16, 12),
    signalGlow,
  );
  tipGlow.position.copy(antennaTip.position);
  head.add(antenna, antennaTip, tipGlow);

  // Subtle actual rear vents and a recessed back seam instead of a pasted rectangular panel.
  const rearSeam = tube(
    [
      new THREE.Vector3(-22, 9, -29),
      new THREE.Vector3(-11, 13, -31.4),
      new THREE.Vector3(0, 14, -32.2),
      new THREE.Vector3(11, 13, -31.4),
      new THREE.Vector3(22, 9, -29),
    ],
    0.65,
    inset,
  );
  head.add(rearSeam);
  const ventGeometry = new THREE.CapsuleGeometry(0.8, 6, 4, 8);
  for (const x of [-6, 0, 6]) {
    const vent = new THREE.Mesh(ventGeometry, inset);
    vent.position.set(x, -5, -32.1);
    vent.scale.z = 0.45;
    head.add(vent);
  }

  // A smooth lathed hull narrows into its levitation emitter; no legs, boots or chest badge.
  const profile = new THREE.SplineCurve([
    new THREE.Vector2(0, -57),
    new THREE.Vector2(10, -56),
    new THREE.Vector2(17, -50),
    new THREE.Vector2(23, -39),
    new THREE.Vector2(25, -29),
    new THREE.Vector2(23, -20),
    new THREE.Vector2(16, -14),
    new THREE.Vector2(0, -13),
  ]);
  const hull = new THREE.Mesh(
    new THREE.LatheGeometry(
      profile
        .getPoints(48)
        .map((p) => new THREE.Vector2(Math.max(0, p.x), p.y)),
      48,
    ),
    shell,
  );
  hull.scale.z = 0.78;
  body.add(hull);
  const chestSignal = roundBox(5.5, 1.4, 1.2, 0.5, signal);
  chestSignal.position.set(0, -31, 19.5);
  body.add(chestSignal);
  const rearPort = roundBox(11, 3, 2, 0.9, inset);
  rearPort.position.set(0, -34, -19.2);
  body.add(rearPort);
  const emitter = new THREE.Mesh(
    new THREE.TorusGeometry(9.4, 0.65, 8, 40),
    signal,
  );
  emitter.rotation.x = Math.PI / 2;
  emitter.position.y = -56.8;
  emitter.scale.y = 0.78;
  body.add(emitter);
  const hoverRing = new THREE.Mesh(
    new THREE.TorusGeometry(12.5, 0.35, 6, 40),
    signalGlow,
  );
  hoverRing.rotation.x = Math.PI / 2;
  hoverRing.position.y = -64;
  hoverRing.scale.y = 0.78;
  body.add(hoverRing);
  const hands: THREE.Group[] = [];
  const handGeometry = new THREE.CapsuleGeometry(6.5, 10, 6, 16);
  for (const sign of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sign * 35, -25, 0);
    const hand = new THREE.Mesh(handGeometry, shell);
    hand.position.set(sign * 5, -7, 0);
    hand.rotation.z = sign * 0.22;
    hand.scale.z = 0.85;
    const handSignal = roundBox(4.5, 1.2, 1, 0.45, signal);
    handSignal.position.set(sign * 5, -6, 5.7);
    pivot.add(hand, handSignal);
    body.add(pivot);
    hands.push(pivot);
  }

  let light = false,
    palette = "";
  const setTheme = (theme: WorkspaceModelTheme) => {
    light = theme === "light";
    shell.color.setHex(light ? 0x536e9e : 0x425b91);
    edge.color.setHex(light ? 0x6d86ac : 0x6a84b1);
    inset.color.setHex(light ? 0x2e4568 : 0x223754);
    visor.color.setHex(light ? 0x0c1930 : 0x061224);
    palette = "";
  };
  const update = (time: number, state: string, reduced: boolean) => {
    const muted = state === "muted",
      still = reduced || muted,
      warning = state === "error",
      notice = state === "notice";
    const t = still ? 0 : time,
      working = isWorking(state),
      listening = state === "listening" || muted,
      speaking = state === "speaking",
      sleeping = ["sleeping", "sleep", "slacking"].includes(state);
    const nextPalette = `${light}:${warning}:${muted}`;
    if (palette !== nextPalette) {
      palette = nextPalette;
      eyeLight.color.setHex(
        warning ? 0xd8b18a : muted ? 0x758eab : light ? 0x8db8dc : 0x9bc5e2,
      );
      signal.color.setHex(warning ? 0xcda276 : muted ? 0x536d88 : 0x8cb2d5);
      signal.emissive.setHex(warning ? 0x805222 : muted ? 0x162b3d : 0x3c6e9b);
      signalGlow.color.setHex(warning ? 0xc79a69 : 0x6993be);
    }
    body.position.y =
      -4 + (still ? 0 : Math.sin(t * (working ? 1.7 : 1.05)) * 1.1);
    head.rotation.y = still
      ? 0
      : Math.sin(t * 0.32) * (working ? 0.025 : 0.045);
    head.rotation.z = listening
      ? -0.07
      : working
        ? 0.025
        : still
          ? 0
          : Math.sin(t * 0.65) * 0.012;
    head.rotation.x = sleeping ? 0.1 : listening ? -0.03 : 0;
    const phase = t % 6.2,
      blink =
        !still && phase > 5.95
          ? Math.max(0.1, Math.min(1, Math.abs(phase - 6.075) / 0.125))
          : 1;
    eyes.scale.y = sleeping ? 0.14 : blink;
    eyes.position.x = still ? 0 : Math.sin(t * 0.32) * 0.45;
    smile.visible = !speaking;
    mouth.visible = speaking;
    mouth.scale.y = still ? 0.7 : 0.48 + Math.abs(Math.sin(t * 6.2)) * 0.45;
    hands[0].rotation.z = working ? -0.1 : still ? 0 : Math.sin(t * 0.9) * 0.03;
    hands[1].rotation.z = listening
      ? 0.65
      : speaking
        ? 0.18 + (still ? 0 : Math.sin(t * 1.9) * 0.08)
        : 0.05;
    const pulse = still ? 0.5 : (Math.sin(t * (notice ? 1.8 : 1.5)) + 1) / 2;
    signal.emissiveIntensity = muted
      ? 0.08
      : warning
        ? 0.4
        : notice
          ? 0.3 + pulse * 0.2
          : 0.26 + (listening || working || speaking ? 0.22 : 0.06) * pulse;
    signalGlow.opacity = muted
      ? 0.025
      : warning
        ? 0.16
        : notice
          ? 0.09 + pulse * 0.1
          : 0.07 + pulse * 0.06;
  };
  setTheme("dark");
  update(0, "idle", true);
  return { group, update, setTheme };
}
