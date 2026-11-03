import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export type WorkspaceModelTheme = "light" | "dark";
export type WorkspaceThreeModel = {
  group: THREE.Group;
  update(timeSeconds: number, state: string, reduced: boolean): void;
  setTheme(theme: WorkspaceModelTheme): void;
};

const tau = Math.PI * 2;
const isWorking = (state: string) =>
  ["working", "thinking", "connecting", "processing"].includes(state);

function tube(
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  closed = false,
) {
  // Closed curves already connect their ends; a duplicated endpoint produces a visible seam.
  const controls =
    closed && points[0].distanceToSquared(points[points.length - 1]) < 0.000001
      ? points.slice(0, -1)
      : points;
  const curve = new THREE.CatmullRomCurve3(controls, closed, "centripetal");
  return new THREE.Mesh(
    new THREE.TubeGeometry(
      curve,
      Math.max(32, controls.length * 2),
      radius,
      5,
      closed,
    ),
    material,
  );
}

function circlePoints(radius: number, start = 0, length = tau, y = 0) {
  return Array.from({ length: 65 }, (_, index) => {
    const angle = start + (index / 64) * length;
    return new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius + y,
      0,
    );
  });
}

/** Genuine spherical meridians/latitudes, with no textures or postprocessing dependency. */
export function createNestModel(): WorkspaceThreeModel {
  const group = new THREE.Group();
  group.name = "xuti-spherical-nest";
  const skeleton = new THREE.Group(),
    currents = new THREE.Group();
  group.add(skeleton, currents);
  const faint = new THREE.MeshBasicMaterial({
    color: 0x526fae,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  const blue = new THREE.MeshBasicMaterial({
    color: 0x7a94ff,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  const cyan = new THREE.MeshBasicMaterial({
    color: 0x81dcef,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });
  const atmosphere = new THREE.MeshBasicMaterial({
    color: 0x526fd6,
    transparent: true,
    opacity: 0.018,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const beacon = new THREE.MeshBasicMaterial({
    color: 0xc2f2ff,
    toneMapped: false,
  });
  const beaconGlow = new THREE.MeshBasicMaterial({
    color: 0x6aabff,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });

  // Three vertical great circles intersect a horizontal equator: every view has real depth.
  for (const angle of [0, Math.PI / 3, (Math.PI * 2) / 3]) {
    const meridian = tube(circlePoints(145), 0.43, faint, true);
    meridian.rotation.y = angle;
    skeleton.add(meridian);
  }
  for (const height of [-70, 0, 70]) {
    const latitude = tube(
      circlePoints(Math.sqrt(145 ** 2 - height ** 2)),
      height === 0 ? 0.55 : 0.38,
      faint,
      true,
    );
    latitude.rotation.x = Math.PI / 2;
    latitude.position.y = height;
    skeleton.add(latitude);
  }
  skeleton.add(
    new THREE.Mesh(new THREE.SphereGeometry(142, 32, 20), atmosphere),
  );

  const paths = [
    {
      radius: 146,
      start: 0.1,
      length: Math.PI * 0.76,
      x: 0.4,
      y: 0.4,
      z: -0.3,
      material: cyan,
    },
    {
      radius: 143,
      start: Math.PI * 0.8,
      length: Math.PI * 0.58,
      x: 1.2,
      y: -0.6,
      z: 0.7,
      material: blue,
    },
    {
      radius: 147,
      start: Math.PI * 1.1,
      length: Math.PI * 0.34,
      x: -0.45,
      y: 1.1,
      z: 0.5,
      material: cyan,
    },
    {
      radius: 139,
      start: Math.PI * 0.3,
      length: Math.PI * 0.35,
      x: 0.7,
      y: 1.45,
      z: 0.3,
      material: blue,
    },
  ];
  const nodeGeometry = new THREE.SphereGeometry(1.85, 10, 8),
    glowGeometry = new THREE.SphereGeometry(4.1, 10, 8);
  for (const path of paths) {
    const orbit = new THREE.Group();
    orbit.rotation.set(path.x, path.y, path.z);
    orbit.add(
      tube(
        circlePoints(path.radius, path.start, path.length),
        0.88,
        path.material,
      ),
    );
    const end = path.start + path.length;
    const node = new THREE.Mesh(nodeGeometry, beacon),
      glow = new THREE.Mesh(glowGeometry, beaconGlow);
    node.position.set(
      Math.cos(end) * path.radius,
      Math.sin(end) * path.radius,
      0,
    );
    glow.position.copy(node.position);
    orbit.add(node, glow);
    currents.add(orbit);
  }

  // Batched equatorial markers remain one draw call.
  const marks: number[] = [];
  for (let index = 0; index < 48; index++) {
    const angle = (index / 48) * tau,
      inner = index % 4 === 0 ? 141.2 : 143.2;
    marks.push(
      Math.cos(angle) * inner,
      0,
      Math.sin(angle) * inner,
      Math.cos(angle) * 146,
      0,
      Math.sin(angle) * 146,
    );
  }
  const ticks = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(marks, 3),
    ),
    new THREE.LineBasicMaterial({
      color: 0x6f91d9,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  skeleton.add(ticks);
  let light = false,
    palette = "";
  const setTheme = (theme: WorkspaceModelTheme) => {
    light = theme === "light";
    faint.color.setHex(light ? 0x5373b6 : 0x526fae);
    blue.color.setHex(light ? 0x4666d9 : 0x7a94ff);
    cyan.color.setHex(light ? 0x168eae : 0x81dcef);
    beacon.color.setHex(light ? 0x168eae : 0xc2f2ff);
    ticks.material.color.setHex(light ? 0x476dc1 : 0x6f91d9);
    palette = "";
  };
  const update = (time: number, state: string, reduced: boolean) => {
    const muted = state === "muted",
      still = reduced || muted,
      warning = state === "error",
      notice = state === "notice",
      t = still ? 0 : time,
      active =
        isWorking(state) || state === "listening" || state === "speaking",
      breath = still ? 0.5 : (Math.sin(t * (active ? 1.7 : 0.82)) + 1) / 2;
    const nextPalette = `${light}:${warning}:${muted}`;
    if (nextPalette !== palette) {
      palette = nextPalette;
      beacon.color.setHex(
        warning ? 0xffcf91 : muted ? 0x8aa1bd : light ? 0x168eae : 0xc2f2ff,
      );
      beaconGlow.color.setHex(warning ? 0xf6ad55 : 0x6aabff);
    }
    currents.rotation.y = still ? 0 : t * (active ? 0.2 : 0.065);
    currents.rotation.z = still ? 0 : Math.sin(t * 0.23) * 0.05;
    skeleton.scale.setScalar(1 + (still ? 0 : Math.sin(t * 0.82) * 0.005));
    faint.opacity = (light ? 0.27 : 0.33) + breath * 0.06;
    blue.opacity = 0.62 + breath * 0.24;
    cyan.opacity = 0.72 + breath * 0.24;
    atmosphere.opacity = (light ? 0.012 : 0.018) + breath * 0.012;
    beaconGlow.opacity = muted
      ? 0.05
      : warning
        ? 0.23
        : notice
          ? 0.16 + (still ? 0.5 : (Math.sin(t * 2.1) + 1) / 2) * 0.13
          : 0.13 + breath * (active ? 0.18 : 0.1);
    // A short, very small decorative tremor, without moving the robot or any hit target.
    const tremor = !still && t % 9.6 > 8.6 ? Math.sin(t * 39) * 0.0012 : 0;
    skeleton.rotation.z = tremor;
  };
  setTheme("dark");
  update(0, "idle", true);
  return { group, update, setTheme };
}

function roundBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  material: THREE.Material,
) {
  return new THREE.Mesh(
    new RoundedBoxGeometry(width, height, depth, 3, radius),
    material,
  );
}

/** XUTI's small blue companion, built as a solid model with a detailed back and sides. */
export function createRobotModel(): WorkspaceThreeModel {
  const group = new THREE.Group();
  group.name = "xuti-robot";
  const body = new THREE.Group(),
    head = new THREE.Group();
  body.position.y = -9;
  head.position.y = 24;
  group.add(body);
  body.add(head);

  const shell = new THREE.MeshStandardMaterial({
    color: 0xd8e2ff,
    roughness: 0.35,
    metalness: 0.12,
  });
  const blue = new THREE.MeshStandardMaterial({
    color: 0x627bea,
    roughness: 0.36,
    metalness: 0.22,
    emissive: 0x1a3395,
    emissiveIntensity: 0.12,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x475eac,
    roughness: 0.44,
    metalness: 0.4,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0xa5b8e6,
    roughness: 0.34,
    metalness: 0.65,
  });
  const visor = new THREE.MeshStandardMaterial({
    color: 0x111c37,
    roughness: 0.2,
    metalness: 0.25,
  });
  const eyeLight = new THREE.MeshBasicMaterial({
    color: 0xc6e8ff,
    toneMapped: false,
  });
  const signalLight = new THREE.MeshStandardMaterial({
    color: 0x96d7ff,
    emissive: 0x559bff,
    emissiveIntensity: 0.65,
    roughness: 0.25,
  });
  const signalGlow = new THREE.MeshBasicMaterial({
    color: 0x6a96ff,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });

  head.add(roundBox(98, 66, 52, 22, shell));
  const bezel = roundBox(93, 54, 38, 18, blue);
  bezel.scale.z = 0.19;
  bezel.position.set(0, -1, 25.8);
  head.add(bezel);
  const face = roundBox(85, 46, 34, 16.5, visor);
  face.scale.z = 0.16;
  face.position.set(0, -1, 29.6);
  head.add(face);

  const eyes = new THREE.Group();
  eyes.position.set(0, 4.5, 33.4);
  const eyeGeometry = new THREE.CapsuleGeometry(3.7, 6.5, 4, 10);
  for (const x of [-21, 21]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeLight);
    eye.position.x = x;
    eye.scale.z = 0.38;
    eyes.add(eye);
  }
  head.add(eyes);
  const smile = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-8, -10, 34),
        new THREE.Vector3(0, -17, 35),
        new THREE.Vector3(8, -10, 34),
      ),
      20,
      1.2,
      6,
      false,
    ),
    eyeLight,
  );
  const speakingMouth = new THREE.Mesh(
    new THREE.TorusGeometry(4.7, 1.1, 6, 20),
    eyeLight,
  );
  speakingMouth.position.set(0, -11, 34.7);
  speakingMouth.visible = false;
  head.add(smile, speakingMouth);

  const earGeometry = new THREE.CylinderGeometry(10, 10, 10, 20),
    earLightGeometry = new THREE.CylinderGeometry(6, 6, 1.8, 20);
  for (const sign of [-1, 1]) {
    const ear = new THREE.Mesh(earGeometry, blue);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(sign * 53.5, 0, 0);
    const light = new THREE.Mesh(earLightGeometry, signalLight);
    light.rotation.z = Math.PI / 2;
    light.position.set(sign * 59.2, 0, 0);
    head.add(ear, light);
  }
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 2.2, 15, 10),
    metal,
  );
  antenna.position.set(0, 40, -1);
  const antennaTip = new THREE.Mesh(
    new THREE.SphereGeometry(4.8, 16, 12),
    blue.clone(),
  );
  antennaTip.position.set(0, 51, -1);
  const tipLight = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 12, 8),
    signalLight,
  );
  tipLight.position.set(0, 52, 2.2);
  const tipGlow = new THREE.Mesh(
    new THREE.SphereGeometry(6.5, 12, 8),
    signalGlow,
  );
  tipGlow.position.copy(antennaTip.position);
  head.add(antenna, antennaTip, tipLight, tipGlow);

  // Back shell details are actual raised/recessed meshes, visible when the world turns around.
  const backRim = roundBox(63, 35, 7, 3.4, blue);
  backRim.position.set(0, -2, -25);
  const backPanel = roundBox(56, 28, 5, 2.4, shell);
  backPanel.position.set(0, -2, -28);
  head.add(backRim, backPanel);
  const ventGeometry = new THREE.CapsuleGeometry(1.1, 7, 3, 6);
  for (let index = -2; index <= 2; index++) {
    const vent = new THREE.Mesh(ventGeometry, trim);
    vent.position.set(index * 6, -4, -30.7);
    vent.scale.z = 0.35;
    head.add(vent);
  }
  for (const sign of [-1, 1]) {
    const mark = roundBox(1.8, 11, 1.3, 0.6, blue);
    mark.position.set(0, 18, -25.3);
    mark.rotation.z = sign * 0.58;
    head.add(mark);
  }

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 10, 16), trim);
  neck.position.y = -9;
  const torso = roundBox(49, 42, 35, 12, blue);
  torso.position.y = -27;
  body.add(neck, torso);
  const chest = roundBox(28, 23, 8, 3.8, shell);
  chest.position.set(0, -26, 17.4);
  body.add(chest);
  // The familiar V-shaped chest indicator is lit, but never represents task completion.
  for (const sign of [-1, 1]) {
    const coreMark = roundBox(2.6, 8, 2, 0.9, blue);
    coreMark.position.set(sign * 2.6, -26, 22);
    coreMark.rotation.z = (sign * -Math.PI) / 4;
    body.add(coreMark);
  }
  const rearPort = roundBox(21, 11, 5, 2.4, visor);
  rearPort.position.set(0, -29, -17.5);
  const port = roundBox(9, 2, 1.5, 0.7, metal);
  port.position.set(0, -29, -20.5);
  body.add(rearPort, port);

  const arms: THREE.Group[] = [];
  const shoulderGeometry = new THREE.SphereGeometry(7, 12, 10),
    armGeometry = new THREE.CapsuleGeometry(5.2, 13, 4, 10),
    handGeometry = new THREE.SphereGeometry(6.4, 12, 10);
  for (const sign of [-1, 1]) {
    const shoulder = new THREE.Mesh(shoulderGeometry, metal);
    shoulder.position.set(sign * 25, -18, 0);
    body.add(shoulder);
    const pivot = new THREE.Group();
    pivot.position.set(sign * 28, -18, 0);
    const arm = new THREE.Mesh(armGeometry, blue);
    arm.position.set(sign * 7, -8, 0);
    arm.rotation.z = sign * 0.53;
    const hand = new THREE.Mesh(handGeometry, shell);
    hand.position.set(sign * 13.5, -19, 1);
    hand.scale.set(0.9, 0.95, 1.15);
    pivot.add(arm, hand);
    body.add(pivot);
    arms.push(pivot);

    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(5.2, 5.8, 10, 12),
      trim,
    );
    leg.position.set(sign * 13, -48, 0);
    const foot = roundBox(22, 13, 28, 6, shell);
    foot.position.set(sign * 14, -56, 5);
    const sole = roundBox(23, 3.8, 29, 1.8, blue);
    sole.position.set(sign * 14, -61, 5);
    body.add(leg, foot, sole);
  }

  let light = false,
    palette = "";
  const setTheme = (theme: WorkspaceModelTheme) => {
    light = theme === "light";
    shell.color.setHex(light ? 0xe4ebff : 0xd8e2ff);
    blue.color.setHex(light ? 0x526fe0 : 0x627bea);
    trim.color.setHex(light ? 0x4059a1 : 0x475eac);
    visor.color.setHex(light ? 0x172447 : 0x111c37);
    eyeLight.color.setHex(light ? 0xb7dbff : 0xc6e8ff);
    palette = "";
  };
  const update = (time: number, state: string, reduced: boolean) => {
    const muted = state === "muted",
      still = reduced || muted,
      warning = state === "error",
      notice = state === "notice",
      t = still ? 0 : time,
      working = isWorking(state),
      listening = state === "listening" || muted,
      speaking = state === "speaking",
      sleeping = ["sleeping", "sleep", "slacking"].includes(state);
    const nextPalette = `${light}:${warning}:${muted}`;
    if (nextPalette !== palette) {
      palette = nextPalette;
      eyeLight.color.setHex(
        warning ? 0xffd39a : muted ? 0x9eb4d5 : light ? 0xb7dbff : 0xc6e8ff,
      );
      signalLight.color.setHex(
        warning ? 0xffca85 : muted ? 0x6d86af : 0x96d7ff,
      );
      signalLight.emissive.setHex(
        warning ? 0xa46524 : muted ? 0x1d3556 : 0x559bff,
      );
      signalGlow.color.setHex(warning ? 0xffb45a : 0x6a96ff);
      antennaTip.material.color.setHex(
        warning ? 0xf6b55f : light ? 0x526fe0 : 0x627bea,
      );
      antennaTip.material.emissive.setHex(warning ? 0x71400c : 0x1a3395);
    }
    body.position.y =
      -9 + (still ? 0 : Math.sin(t * (working ? 2 : 1.3)) * 1.15);
    head.rotation.y = still ? 0 : Math.sin(t * 0.38) * (working ? 0.04 : 0.065);
    head.rotation.z = listening
      ? -0.09
      : working
        ? 0.035
        : still
          ? 0
          : Math.sin(t * 0.8) * 0.018;
    head.rotation.x = sleeping ? 0.13 : listening ? -0.04 : 0;
    const phase = t % 5.8,
      blink =
        !still && phase > 5.55
          ? Math.max(0.1, Math.min(1, Math.abs(phase - 5.675) / 0.125))
          : 1;
    eyes.scale.y = sleeping ? 0.14 : blink;
    eyes.position.x = still ? 0 : Math.sin(t * 0.38) * 0.7;
    smile.visible = !speaking;
    speakingMouth.visible = speaking;
    speakingMouth.scale.y = still
      ? 0.7
      : 0.45 + Math.abs(Math.sin(t * 6.8)) * 0.6;
    arms[0].rotation.z = working
      ? -0.15
      : still
        ? 0
        : Math.sin(t * 1.1) * 0.035;
    arms[1].rotation.z = listening
      ? 1.3
      : speaking
        ? 0.25 + (still ? 0 : Math.sin(t * 2.2) * 0.12)
        : 0.12;
    const pulse = still ? 0.5 : (Math.sin(t * (notice ? 2.1 : 2)) + 1) / 2;
    signalLight.emissiveIntensity = muted
      ? 0.12
      : warning
        ? 0.6
        : notice
          ? 0.45 + pulse * 0.32
          : 0.45 + (listening || working || speaking ? 0.35 : 0.1) * pulse;
    signalGlow.opacity = muted
      ? 0.035
      : warning
        ? 0.22
        : notice
          ? 0.12 + pulse * 0.13
          : 0.11 + (still ? 0.04 : (Math.sin(t * 1.4) + 1) * 0.045);
  };
  setTheme("dark");
  update(0, "idle", true);
  return { group, update, setTheme };
}
