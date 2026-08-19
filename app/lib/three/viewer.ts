import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import gsap from "gsap";
import type { Hotspot } from "../../i18n/merge";
import { AnatomyAssetManager, type LoadedOrgan } from "./loaders";
import { HotspotLayer } from "./hotspots";

type ViewerCallbacks = {
  onLoading: (loading: boolean, progress: number) => void;
  onSelect: (hotspot: Hotspot | null) => void;
  /** Quiz mode: every dot press is reported, with no selection toggling. */
  onPick?: (hotspot: Hotspot) => void;
  /** Authoring mode: a point on the mesh surface, in pivot space. */
  onAuthorPoint?: (point: { x: number; y: number; z: number }) => void;
};

type ClinicalHeartState = "normal" | "disease" | "postop";

type ClinicalFlow = {
  points: THREE.Points;
  positions: Float32Array;
  count: number;
  reverse: boolean;
};

type ClinicalValveAnimation = {
  mesh: THREE.Mesh;
  originalGeometry: THREE.BufferGeometry;
  animatedGeometry: THREE.BufferGeometry;
  originalPositions: Float32Array;
  center: THREE.Vector3;
  flowDirection: THREE.Vector3;
  splitAxis: THREE.Vector3;
  maxSplit: number;
  amplitude: number;
  openness: number;
};

const DOT_PIXELS = 34;
const CAMERA_FOV = 34;
const DEPTH_PREPASS = "depth-prepass";
const CONTACT_SHADOW_Y = -2.32;
const HOME_CAMERA = { x: 0, y: 1.05, z: 8.2 };
const HOME_TARGET = { x: 0, y: 0.02, z: 0 };

export class AnatomyViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  private controls: OrbitControls;
  private assets: AnatomyAssetManager;
  private hotspots = new HotspotLayer();
  private callbacks: ViewerCallbacks;
  private container: HTMLElement;
  private organ: LoadedOrgan | null = null;
  private contactShadow!: THREE.Mesh;

  private frame = 0;
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  /** Writes depth only — used to resolve a fading organ to one surface. */
  private depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
  private crossSection = false;
  private isolated = false;
  private zoomed = false;

  private width = 1;
  private height = 1;
  private isVisible = true;
  private isPageVisible = true;

  // Render-on-demand bookkeeping: the loop only draws when something moved.
  private dirty = true;
  private busyUntil = 0;
  private loadRequest = 0;

  private basePixelRatio: number;

  private autoRotateWanted = true;
  private interactionUntil = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private hoverProbe: { x: number; y: number } | null = null;
  private pointerId: number | null = null;
  private pointerStart = { x: 0, y: 0 };
  private dragged = false;
  private calloutEl: HTMLElement | null = null;
  private fadeTween: gsap.core.Tween | null = null;
  private disposed = false;
  private quizMode = false;
  private authoring = false;
  private authorRaycaster = new THREE.Raycaster();
  private clinicalRequest: { state: ClinicalHeartState; playing: boolean; phase: "filling" | "pumping" } | null = null;
  private clinicalValve: ClinicalValveAnimation | null = null;
  private clinicalForwardFlow: ClinicalFlow | null = null;
  private clinicalRefluxFlow: ClinicalFlow | null = null;
  private clinicalFlowCenter = new THREE.Vector3();
  private clinicalFlowDirection = new THREE.Vector3(0, -1, 0);
  private clinicalFlowSide = new THREE.Vector3(1, 0, 0);
  private clinicalFlowUp = new THREE.Vector3(0, 0, 1);
  private clinicalTime = 0;

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const lowPower = window.matchMedia("(max-width: 780px)").matches || (navigator.hardwareConcurrency ?? 8) < 6;
    // Fixed, decided once. A dynamic controller used to live here and it was a
    // net negative: frame *intervals* are vsync-quantised, so a brief hitch read
    // as GPU load, dropped the buffer, and — because a vsync-locked 16.7ms never
    // met the step-up threshold — never recovered. The scene renders in ~2ms, so
    // there is nothing to adapt away from.
    this.basePixelRatio = Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !lowPower,
      alpha: true,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    // Shadow mapping would render every organ twice per frame; a baked contact
    // shadow gives the same read for free.
    this.renderer.shadowMap.enabled = false;
    this.renderer.localClippingEnabled = true;
    // Localised by the React layer via setCanvasLabel once the dictionary is known.
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D anatomy model");
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(HOME_CAMERA.x, HOME_CAMERA.y, HOME_CAMERA.z);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 4.8;
    this.controls.maxDistance = 12;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.target.set(HOME_TARGET.x, HOME_TARGET.y, HOME_TARGET.z);

    this.assets = new AnatomyAssetManager(this.renderer);
    this.buildEnvironment();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.isVisible = entry.isIntersecting;
        if (this.isVisible) this.dirty = true;
      },
      { rootMargin: "120px" },
    );
    this.intersectionObserver.observe(container);

    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.controls.addEventListener("start", this.onControlStart);
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("keydown", this.onKeyDown);

    this.resize();
    this.animate();
  }

  // ---------------------------------------------------------------- scene

  private buildEnvironment() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x33252d, 0.72));

    const key = new THREE.DirectionalLight(0xfff3e7, 3.5);
    key.position.set(4.8, 6.5, 6.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe6ecff, 1.12);
    fill.position.set(-4.5, 1.2, 5.2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffb7a5, 1.6);
    rim.position.set(-4, 3.5, -5.5);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff8d70, 0.72, 11, 2);
    warm.position.set(-3, -1.4, 3.5);
    this.scene.add(warm);
    const glow = new THREE.PointLight(0xee7c6a, 0.5, 8, 2);
    glow.name = "organ-glow";
    glow.position.set(2.8, 0.4, 2.8);
    this.scene.add(glow);

    this.scene.environment = this.buildEnvironmentMap();

    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 4.2),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.62,
        toneMapped: false,
      }),
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = CONTACT_SHADOW_Y;
    this.contactShadow.renderOrder = 1;
    this.scene.add(this.contactShadow);

    const positions = new Float32Array(48 * 3);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = (Math.random() - 0.5) * 9;
      positions[i + 1] = (Math.random() - 0.5) * 6;
      positions[i + 2] = (Math.random() - 0.5) * 5 - 2;
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.scene.add(
      new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({ color: 0xe7a18e, size: 0.013, transparent: true, opacity: 0.16 }),
      ),
    );
  }

  /** A tiny warm-to-cool gradient probe: better material response than a bare
   *  light rig, and it costs one PMREM bake instead of per-frame work. */
  private buildEnvironmentMap() {
    const width = 16;
    const height = 32;
    const data = new Uint8Array(width * height * 4);
    const top = new THREE.Color(0xfff3e4);
    const bottom = new THREE.Color(0x6b4f45);
    const mixed = new THREE.Color();
    for (let y = 0; y < height; y += 1) {
      mixed.copy(bottom).lerp(top, Math.pow(1 - y / (height - 1), 0.7));
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = mixed.r * 255;
        data[i + 1] = mixed.g * 255;
        data[i + 2] = mixed.b * 255;
        data[i + 3] = 255;
      }
    }
    const source = new THREE.DataTexture(data, width, height);
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    source.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = pmrem.fromEquirectangular(source).texture;
    pmrem.dispose();
    source.dispose();
    return environment;
  }

  // ---------------------------------------------------------------- organs

  prefetch(url: string) {
    this.assets.prefetch(url);
  }

  async setOrgan(modelUrl: string, hotspots: Hotspot[], accent: string) {
    const request = ++this.loadRequest;
    this.select(null);
    this.callbacks.onLoading(true, 0);

    const outgoing = this.organ;
    if (outgoing) {
      this.clearClinicalHeartAnimation();
      // Switching mid-fade would otherwise leave the tween running and the
      // depth proxies attached to a released organ.
      this.fadeTween?.kill();
      this.fadeTween = null;
      this.setDepthPrepass(outgoing, false);
      this.hotspots.clear();
      this.busy(0.8);
      await gsap.to(outgoing.pivot.scale, {
        x: 0.72, y: 0.72, z: 0.72,
        duration: 0.34,
        ease: "power2.in",
        onUpdate: () => (this.dirty = true),
      });
      this.assets.release(outgoing);
      this.organ = null;
      this.dirty = true;
    }

    this.tween(this.camera.position, { z: 9.2, duration: 0.42, ease: "power2.inOut" });

    let organ: LoadedOrgan;
    try {
      organ = await this.assets.load(modelUrl, (progress) => {
        if (request === this.loadRequest) this.callbacks.onLoading(true, progress);
      });
    } catch (error) {
      if (request === this.loadRequest) this.callbacks.onLoading(false, 0);
      throw error;
    }
    if (request !== this.loadRequest || this.disposed) return;

    this.organ = organ;
    organ.pivot.scale.setScalar(1);
    organ.pivot.position.set(0, 0, 0);
    this.scene.add(organ.pivot);
    organ.pivot.updateWorldMatrix(true, true);

    // Anchor the dots while the organ is still invisible, then play the intro.
    this.hotspots.attach(organ.pivot, hotspots, organ.meshes);
    this.hotspots.setPixelSize(DOT_PIXELS, this.height, CAMERA_FOV);
    if (this.crossSection) this.applyClipping(true);

    const glow = this.scene.getObjectByName("organ-glow") as THREE.PointLight | undefined;
    glow?.color.set(accent);

    organ.pivot.scale.setScalar(0.58);
    organ.pivot.position.z = -1.3;
    this.busy(1.4);
    this.fade(organ, 1, 0.72);
    // The organ is on screen from here on, so the load is over as far as the UI
    // is concerned — the intro animation should play in the open, not behind a
    // loading panel.
    this.callbacks.onLoading(false, 1);
    gsap.timeline({ onUpdate: () => (this.dirty = true) })
      .to(organ.pivot.scale, { x: 1, y: 1, z: 1, duration: 0.9, ease: "back.out(1.25)" }, 0)
      .to(organ.pivot.position, { z: 0, duration: 0.85, ease: "power3.out" }, 0)
      .to(this.camera.position, { z: 8.2, duration: 0.9, ease: "power2.out" }, 0.08);
    if (this.clinicalRequest) this.setupClinicalHeartAnimation();
  }

  private materials(organ: LoadedOrgan) {
    const list: THREE.Material[] = [];
    organ.meshes.forEach((mesh) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => list.includes(material) || list.push(material));
    });
    return list;
  }

  /**
   * Fades an organ in. Depth writing stays ON throughout: these are solid,
   * closed meshes, and letting them blend in draw order instead of depth order
   * makes the far side and interior show through the front for the length of
   * the tween. A depth prepass keeps the result identical to the opaque pass —
   * only the nearest surface is ever shaded.
   */
  private fade(organ: LoadedOrgan, to: number, duration: number) {
    const materials = this.materials(organ);
    const state = { value: to >= 1 ? 0 : 1 };
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = state.value * ((material.userData.anatomyOpacity as number | undefined) ?? 1);
      material.depthWrite = true;
    });
    this.setDepthPrepass(organ, true);
    this.busy(duration + 0.1);
    this.fadeTween = gsap.to(state, {
      value: to,
      duration,
      ease: "power2.out",
      onUpdate: () => {
        materials.forEach((material) => (material.opacity = state.value * ((material.userData.anatomyOpacity as number | undefined) ?? 1)));
        this.dirty = true;
      },
      onComplete: () => {
        if (to >= 1) {
          materials.forEach((material) => {
            const opacity = (material.userData.anatomyOpacity as number | undefined) ?? 1;
            material.transparent = opacity < 0.999;
            material.opacity = opacity;
            material.depthWrite = opacity >= 0.999;
            material.side = opacity < 0.999 ? THREE.DoubleSide : THREE.FrontSide;
          });
        }
        this.setDepthPrepass(organ, false);
        this.fadeTween = null;
        this.dirty = true;
      },
    });
  }

  /**
   * Lays down depth for the organ before it is shaded, so a partly transparent
   * mesh still resolves to a single nearest surface per pixel. The proxy is
   * parented to the mesh it mirrors, so it inherits the intro animation for
   * free. Opaque, therefore drawn before anything transparent. Alive only while
   * an organ fades; it costs one depth-only pass over ~120k triangles.
   */
  private setDepthPrepass(organ: LoadedOrgan, enabled: boolean) {
    organ.meshes.forEach((mesh) => {
      const existing = mesh.children.find((child) => child.name === DEPTH_PREPASS);
      if (!enabled) {
        existing?.removeFromParent();
        return;
      }
      if (existing) return;
      const proxy = new THREE.Mesh(mesh.geometry, this.depthMaterial);
      proxy.name = DEPTH_PREPASS;
      proxy.frustumCulled = mesh.frustumCulled;
      mesh.add(proxy);
    });
  }

  // ---------------------------------------------------------------- loop

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    if (!this.isVisible || !this.isPageVisible) return;

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();

    this.applyAutoRotate(now);
    if (this.controls.update(delta)) this.dirty = true;
    if (this.assets.hasAnimation) {
      this.assets.update(delta);
      this.dirty = true;
    }
    if (this.clinicalRequest && this.clinicalValve) this.updateClinicalHeartAnimation(delta);
    if (this.hoverProbe) this.resolveHover();
    if (!this.dirty && now >= this.busyUntil) return;

    if (!this.hotspots.update(this.camera, delta, this.selectedId, this.hoveredId)) this.dirty = true;
    else this.dirty = false;
    if (now < this.busyUntil) this.dirty = true;

    this.positionCallout();
    this.renderer.render(this.scene, this.camera);
  };

  private busy(seconds: number) {
    this.busyUntil = Math.max(this.busyUntil, performance.now() + seconds * 1000);
    this.dirty = true;
  }

  private tween(target: object, vars: gsap.TweenVars) {
    this.busy((vars.duration as number) ?? 0.5);
    return gsap.to(target, { ...vars, onUpdate: () => (this.dirty = true) });
  }

  private applyAutoRotate(now: number) {
    this.controls.autoRotate = this.autoRotateWanted && !this.selectedId && now >= this.interactionUntil;
  }

  private onVisibilityChange = () => {
    this.isPageVisible = !document.hidden;
    if (this.isPageVisible) {
      this.clock.start();
      this.dirty = true;
    }
  };

  private resize() {
    this.width = Math.max(this.container.clientWidth, 1);
    this.height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.hotspots.setPixelSize(DOT_PIXELS, this.height, CAMERA_FOV);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- input

  private onControlStart = () => {
    this.interactionUntil = performance.now() + 3000;
    this.dirty = true;
  };

  private onPointerDown = (event: PointerEvent) => {
    this.pointerId = event.pointerId;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.dragged = false;
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointerId !== null) {
      if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) this.dragged = true;
      return;
    }
    this.hoverProbe = { x: event.offsetX, y: event.offsetY };
    this.dirty = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    const wasDragging = this.dragged;
    this.pointerId = null;
    this.dragged = false;
    if (wasDragging) return;

    // Authoring takes precedence: it wants a point on the mesh, not a marker.
    if (this.authoring) {
      this.captureAuthorPoint(event.offsetX, event.offsetY);
      return;
    }

    const marker = this.hotspots.pick(event.offsetX, event.offsetY, this.camera, this.width, this.height);
    if (this.quizMode) {
      // Every press counts as an answer, so no toggling and no sticky selection.
      if (marker) this.callbacks.onPick?.(marker.hotspot);
      return;
    }
    this.select(marker && marker.hotspot.id !== this.selectedId ? marker.hotspot.id : null);
  };

  /**
   * Raycasts the actual mesh and reports the hit in pivot space — the same
   * coordinate system `anatomy-data.ts` authors hotspots in. Only ever runs on
   * a deliberate click in authoring mode, so its cost never touches the
   * interactive path.
   */
  private captureAuthorPoint(px: number, py: number) {
    if (!this.organ) return;
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.authorRaycaster.setFromCamera(ndc, this.camera);
    const hit = this.authorRaycaster.intersectObjects(this.organ.meshes, false)[0];
    if (!hit) return;
    const local = this.organ.pivot.worldToLocal(hit.point.clone());
    this.callbacks.onAuthorPoint?.({
      x: +local.x.toFixed(2),
      y: +local.y.toFixed(2),
      z: +local.z.toFixed(2),
    });
  }

  /** Where a dot currently sits, as a 0–1 fraction of the viewport height.
   *  Lets the UI place feedback away from the structure it is pointing at. */
  hotspotScreenY(id: string): number | null {
    const point = this.hotspots.screenPosition(id, this.camera, this.width, this.height);
    return point ? point.y / this.height : null;
  }

  setQuizMode(enabled: boolean) {
    this.quizMode = enabled;
    this.select(null);
    this.hotspots.clearFlash();
    this.dirty = true;
  }

  setAuthoring(enabled: boolean) {
    this.authoring = enabled;
    this.renderer.domElement.style.cursor = enabled ? "crosshair" : "";
    this.dirty = true;
  }

  /** Green/red ring on a dot after a quiz answer. */
  flash(id: string, correct: boolean) {
    this.hotspots.flash(id, correct);
    this.busy(1.1);
  }

  private onPointerLeave = () => {
    this.pointerId = null;
    this.hoverProbe = null;
    if (this.hoveredId) {
      this.hoveredId = null;
      this.dirty = true;
    }
  };

  private resolveHover() {
    const probe = this.hoverProbe;
    this.hoverProbe = null;
    if (!probe) return;
    const marker = this.hotspots.pick(probe.x, probe.y, this.camera, this.width, this.height);
    const id = marker?.hotspot.id ?? null;
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.dirty = true;
  }

  private select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.busy(0.4);
    const marker = this.hotspots.list.find((item) => item.hotspot.id === id);
    this.callbacks.onSelect(marker?.hotspot ?? null);
  }

  clearSelection() {
    this.select(null);
  }

  /** The callout is positioned imperatively so tracking a spinning model never
   *  triggers a React render. */
  attachCallout(element: HTMLElement | null) {
    this.calloutEl = element;
    this.positionCallout();
    this.dirty = true;
  }

  private positionCallout() {
    if (!this.calloutEl || !this.selectedId) return;
    const point = this.hotspots.screenPosition(this.selectedId, this.camera, this.width, this.height);
    if (!point) return;
    this.calloutEl.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
    this.calloutEl.dataset.side = point.x > this.width * 0.6 ? "left" : "right";
    this.calloutEl.dataset.behind = point.opacity < 0.3 ? "true" : "false";
  }

  private onKeyDown = (event: KeyboardEvent) => {
    const pivot = this.organ?.pivot;
    if (event.key === "ArrowLeft" && pivot) pivot.rotation.y -= 0.08;
    if (event.key === "ArrowRight" && pivot) pivot.rotation.y += 0.08;
    if (event.key === "+") this.camera.position.z = Math.max(4.8, this.camera.position.z - 0.35);
    if (event.key === "-") this.camera.position.z = Math.min(12, this.camera.position.z + 0.35);
    if (event.key === "Escape") this.select(null);
    this.dirty = true;
  };

  // ---------------------------------------------------------------- tools

  setCanvasLabel(label: string) {
    this.renderer.domElement.setAttribute("aria-label", label);
  }

  setAutoRotate(enabled: boolean) {
    this.autoRotateWanted = enabled;
    if (enabled) this.interactionUntil = 0;
    this.dirty = true;
  }

  reset() {
    this.select(null);
    this.zoomed = false;
    this.isolated = false;
    this.crossSection = false;
    this.clipPlane.constant = -1.8;
    this.applyClipping(false);
    this.tween(this.contactShadow.material, { opacity: 0.55, duration: 0.45 });
    if (this.organ) {
      this.materials(this.organ).forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) material.wireframe = false;
      });
    }
    this.tween(this.camera.position, { ...HOME_CAMERA, duration: 0.8, ease: "power3.out" });
    this.tween(this.controls.target, { ...HOME_TARGET, duration: 0.8, ease: "power3.out" });
    if (this.organ) this.tween(this.organ.pivot.rotation, { x: 0.05, y: -0.28, z: 0, duration: 0.8, ease: "power3.out" });
  }

  zoom(direction: 1 | -1) {
    this.tween(this.camera.position, {
      z: THREE.MathUtils.clamp(this.camera.position.z + direction * 1.2, 4.8, 12),
      duration: 0.5,
      ease: "power2.out",
    });
  }

  toggleZoom() {
    this.zoomed = !this.zoomed;
    this.tween(this.camera.position, {
      z: this.zoomed ? 5.6 : HOME_CAMERA.z,
      duration: 0.55,
      ease: "power2.out",
    });
    return this.zoomed;
  }

  toggleIsolate() {
    this.isolated = !this.isolated;
    this.tween(this.contactShadow.material, { opacity: this.isolated ? 0.08 : 0.55, duration: 0.45 });
    return this.isolated;
  }

  toggleCrossSection() {
    this.crossSection = !this.crossSection;
    this.applyClipping(this.crossSection);
    gsap.fromTo(
      this.clipPlane,
      { constant: -1.8 },
      {
        constant: this.crossSection ? 0 : -1.8,
        duration: 0.85,
        ease: "power2.inOut",
        onUpdate: () => (this.dirty = true),
      },
    );
    this.busy(0.95);
    return this.crossSection;
  }

  private applyClipping(enabled: boolean) {
    if (!this.organ) return;
    const planes = enabled ? [this.clipPlane] : null;
    [...this.materials(this.organ), this.depthMaterial].forEach((material) => {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    });
    this.dirty = true;
  }

  toggleLayers() {
    if (!this.organ) return false;
    let enabled = false;
    this.materials(this.organ).forEach((material) => {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.wireframe = !material.wireframe;
        enabled = material.wireframe;
      }
    });
    this.dirty = true;
    return enabled;
  }

  setStructureVisible(nodeName: string, visible: boolean) {
    if (!this.organ) return false;
    const mesh = this.organ.meshes.find((item) => item.name === nodeName);
    if (!mesh) return false;
    mesh.visible = visible;
    this.dirty = true;
    return true;
  }

  colorStructures(entries: Array<{ nodeName: string; color: string }>) {
    if (!this.organ) return;
    const colors = new Map(entries.map((entry) => [entry.nodeName, entry.color]));
    this.organ.meshes.forEach((mesh) => {
      const color = colors.get(mesh.name);
      if (!color) return;
      if (!mesh.userData.anatomyPalette) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((material) => material.clone())
          : mesh.material.clone();
        mesh.userData.anatomyPalette = true;
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.color.set(color);
          material.roughness = 0.58;
          material.transparent = false;
          material.opacity = 1;
          material.depthWrite = true;
          material.needsUpdate = true;
        }
      });
    });
    this.dirty = true;
  }

  setStructureOpacity(nodeName: string, opacity: number) {
    if (!this.organ) return;
    const mesh = this.organ.meshes.find((item) => item.name === nodeName);
    if (!mesh) return;
    if (!mesh.userData.anatomyOpacityMaterial) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
      mesh.userData.anatomyOpacityMaterial = true;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      material.userData.anatomyOpacity = opacity;
      material.opacity = opacity;
      material.transparent = opacity < 0.999;
      material.depthWrite = opacity >= 0.999;
      material.side = opacity < 0.999 ? THREE.DoubleSide : THREE.FrontSide;
      material.needsUpdate = true;
    });
    this.dirty = true;
  }

  setStructuresVisible(nodeNames: string[], visible: boolean) {
    if (!this.organ) return;
    const names = new Set(nodeNames);
    this.organ.meshes.forEach((mesh) => {
      if (names.has(mesh.name)) mesh.visible = visible;
    });
    this.dirty = true;
  }

  isolateStructure(nodeName: string) {
    if (!this.organ) return;
    this.organ.meshes.forEach((mesh) => (mesh.visible = mesh.name === nodeName));
    this.dirty = true;
  }

  showAllStructures() {
    if (!this.organ) return;
    this.organ.meshes.forEach((mesh) => (mesh.visible = true));
    this.dirty = true;
  }

  /**
   * Drives the perioperative teaching scene with the actual HRA valve mesh.
   * The source model has no rig or morph targets, so the leaflets are deformed
   * directly from their original vertices. Flow follows the measured line from
   * the left atrium through the mitral valve toward the left ventricle.
   */
  setClinicalHeartAnimation(state: ClinicalHeartState, playing: boolean, phase: "filling" | "pumping") {
    this.clinicalRequest = { state, playing, phase };
    if (this.organ && !this.clinicalValve) this.setupClinicalHeartAnimation();
    if (this.clinicalValve) {
      this.colorStructures([{
        nodeName: "VH_M_mitral_valve",
        color: state === "disease" ? "#d7443e" : state === "postop" ? "#45a56a" : "#d7a34c",
      }]);
      this.updateClinicalHeartAnimation(0);
    }
    this.busy(0.25);
  }

  private setupClinicalHeartAnimation() {
    if (!this.organ || this.clinicalValve) return;
    const pivot = this.organ.pivot;
    const mitral = this.organ.meshes.find((mesh) => mesh.name === "VH_M_mitral_valve");
    const atrium = this.organ.meshes.find((mesh) => mesh.name === "VH_M_left_cardiac_atrium");
    const ventricle = this.organ.meshes.find((mesh) => mesh.name === "VH_M_heart_left_ventricle");
    if (!mitral || !atrium || !ventricle) return;

    pivot.updateWorldMatrix(true, true);
    const centerInPivot = (object: THREE.Object3D) => {
      const world = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      return pivot.worldToLocal(world);
    };
    const atriumCenter = centerInPivot(atrium);
    const ventricleCenter = centerInPivot(ventricle);
    this.clinicalFlowCenter.copy(centerInPivot(mitral));
    this.clinicalFlowDirection.copy(ventricleCenter).sub(atriumCenter).normalize();
    const helper = Math.abs(this.clinicalFlowDirection.y) < 0.86 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.clinicalFlowSide.copy(this.clinicalFlowDirection).cross(helper).normalize();
    this.clinicalFlowUp.copy(this.clinicalFlowSide).cross(this.clinicalFlowDirection).normalize();

    const originalGeometry = mitral.geometry;
    const animatedGeometry = originalGeometry.clone();
    const position = animatedGeometry.getAttribute("position") as THREE.BufferAttribute;
    const originalPositions = new Float32Array(position.array as ArrayLike<number>);
    animatedGeometry.computeBoundingBox();
    const box = animatedGeometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const worldOrigin = pivot.localToWorld(this.clinicalFlowCenter.clone());
    const worldAlongFlow = pivot.localToWorld(this.clinicalFlowCenter.clone().add(this.clinicalFlowDirection));
    const localOrigin = mitral.worldToLocal(worldOrigin.clone());
    const localFlow = mitral.worldToLocal(worldAlongFlow.clone()).sub(localOrigin).normalize();
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const dimensions = [size.x, size.y, size.z];
    let splitAxis = axes[0];
    let bestScore = -Infinity;
    axes.forEach((axis, index) => {
      const score = dimensions[index] * (1 - Math.abs(axis.dot(localFlow)));
      if (score > bestScore) { bestScore = score; splitAxis = axis; }
    });
    let maxSplit = 0;
    for (let i = 0; i < originalPositions.length; i += 3) {
      const projection = (originalPositions[i] - center.x) * splitAxis.x
        + (originalPositions[i + 1] - center.y) * splitAxis.y
        + (originalPositions[i + 2] - center.z) * splitAxis.z;
      maxSplit = Math.max(maxSplit, Math.abs(projection));
    }
    mitral.geometry = animatedGeometry;
    this.clinicalValve = {
      mesh: mitral,
      originalGeometry,
      animatedGeometry,
      originalPositions,
      center,
      flowDirection: localFlow,
      splitAxis: splitAxis.clone(),
      maxSplit: Math.max(maxSplit, 0.001),
      amplitude: Math.max(size.x, size.y, size.z) * 0.16,
      openness: this.clinicalRequest?.phase === "filling" ? 1 : 0,
    };

    this.clinicalForwardFlow = this.createClinicalFlow(48, 0xff4938, false);
    this.clinicalRefluxFlow = this.createClinicalFlow(38, 0x10cfff, true);
    pivot.add(this.clinicalForwardFlow.points, this.clinicalRefluxFlow.points);
    this.updateClinicalHeartAnimation(0);
  }

  private createClinicalFlow(count: number, color: number, reverse: boolean): ClinicalFlow {
    const positions = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: reverse ? 0.115 : 0.092,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = reverse ? "clinical-mitral-reflux" : "clinical-mitral-forward-flow";
    points.frustumCulled = false;
    points.renderOrder = 8;
    return { points, positions, count, reverse };
  }

  private updateClinicalHeartAnimation(delta: number) {
    const request = this.clinicalRequest;
    const valve = this.clinicalValve;
    if (!request || !valve) return;
    if (request.playing) this.clinicalTime += delta;

    const targetOpen = request.phase === "filling" ? 1 : 0;
    valve.openness = delta > 0 ? THREE.MathUtils.damp(valve.openness, targetOpen, 8, delta) : targetOpen;
    const position = valve.animatedGeometry.getAttribute("position") as THREE.BufferAttribute;
    const target = position.array as Float32Array;
    const diseaseGap = request.state === "disease" && request.phase === "pumping" ? 1 : 0;
    for (let i = 0; i < target.length; i += 3) {
      const x = valve.originalPositions[i];
      const y = valve.originalPositions[i + 1];
      const z = valve.originalPositions[i + 2];
      const projection = (x - valve.center.x) * valve.splitAxis.x
        + (y - valve.center.y) * valve.splitAxis.y
        + (z - valve.center.z) * valve.splitAxis.z;
      const centreWeight = Math.pow(1 - Math.min(Math.abs(projection) / valve.maxSplit, 1), 2);
      const side = projection < 0 ? -1 : 1;
      const spread = valve.amplitude * centreWeight * (valve.openness * 0.95 + diseaseGap * 0.32) * side;
      const bend = valve.amplitude * centreWeight * (valve.openness * 0.28 - (diseaseGap && side > 0 ? 0.52 : 0));
      target[i] = x + valve.splitAxis.x * spread + valve.flowDirection.x * bend;
      target[i + 1] = y + valve.splitAxis.y * spread + valve.flowDirection.y * bend;
      target[i + 2] = z + valve.splitAxis.z * spread + valve.flowDirection.z * bend;
    }
    position.needsUpdate = true;
    valve.animatedGeometry.computeVertexNormals();
    valve.animatedGeometry.computeBoundingSphere();

    const forwardActive = request.phase === "filling";
    const refluxActive = request.phase === "pumping" && request.state !== "normal";
    if (this.clinicalForwardFlow) {
      this.clinicalForwardFlow.points.visible = forwardActive;
      this.updateClinicalFlow(this.clinicalForwardFlow, request.state === "postop" ? 0.82 : 1);
    }
    if (this.clinicalRefluxFlow) {
      this.clinicalRefluxFlow.points.visible = refluxActive;
      const material = this.clinicalRefluxFlow.points.material as THREE.PointsMaterial;
      material.opacity = request.state === "postop" ? 0.3 : 1;
      material.size = request.state === "postop" ? 0.055 : 0.115;
      this.updateClinicalFlow(this.clinicalRefluxFlow, request.state === "postop" ? 0.48 : 1);
    }
    if (request.playing || delta === 0) this.dirty = true;
  }

  private updateClinicalFlow(flow: ClinicalFlow, strength: number) {
    const direction = flow.reverse ? this.clinicalFlowDirection.clone().multiplyScalar(-1) : this.clinicalFlowDirection;
    const span = (flow.reverse ? 1.35 : 1.08) * strength;
    const speed = flow.reverse ? 0.48 : 0.62;
    for (let i = 0; i < flow.count; i += 1) {
      const seed = (i * 0.61803398875) % 1;
      const progress = (seed + this.clinicalTime * speed) % 1;
      const angle = i * 2.3999632297;
      const radius = (0.025 + 0.085 * Math.sin(Math.PI * progress)) * strength;
      const axial = (progress - 0.5) * span;
      const offset = i * 3;
      flow.positions[offset] = this.clinicalFlowCenter.x + direction.x * axial
        + this.clinicalFlowSide.x * Math.cos(angle) * radius + this.clinicalFlowUp.x * Math.sin(angle) * radius;
      flow.positions[offset + 1] = this.clinicalFlowCenter.y + direction.y * axial
        + this.clinicalFlowSide.y * Math.cos(angle) * radius + this.clinicalFlowUp.y * Math.sin(angle) * radius;
      flow.positions[offset + 2] = this.clinicalFlowCenter.z + direction.z * axial
        + this.clinicalFlowSide.z * Math.cos(angle) * radius + this.clinicalFlowUp.z * Math.sin(angle) * radius;
    }
    (flow.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  private clearClinicalHeartAnimation() {
    if (this.clinicalValve) {
      this.clinicalValve.mesh.geometry = this.clinicalValve.originalGeometry;
      this.clinicalValve.animatedGeometry.dispose();
      this.clinicalValve = null;
    }
    [this.clinicalForwardFlow, this.clinicalRefluxFlow].forEach((flow) => {
      if (!flow) return;
      flow.points.removeFromParent();
      flow.points.geometry.dispose();
      (flow.points.material as THREE.Material).dispose();
    });
    this.clinicalForwardFlow = null;
    this.clinicalRefluxFlow = null;
  }

  setPresentation(distance: number, offsetX = 0) {
    this.tween(this.camera.position, { z: distance, duration: 0.55, ease: "power2.out" });
    if (this.organ) this.tween(this.organ.pivot.position, { x: offsetX, duration: 0.55, ease: "power2.out" });
  }

  dispose() {
    this.disposed = true;
    this.loadRequest += 1;
    cancelAnimationFrame(this.frame);
    gsap.killTweensOf(this.camera.position);
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("keydown", this.onKeyDown);

    this.clearClinicalHeartAnimation();
    this.hotspots.dispose();
    this.depthMaterial.dispose();
    this.assets.dispose();
    this.scene.environment?.dispose();
    (this.contactShadow.material as THREE.MeshBasicMaterial).map?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

function contactShadowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, "rgba(94, 62, 42, 0.62)");
  gradient.addColorStop(0.45, "rgba(94, 62, 42, 0.26)");
  gradient.addColorStop(1, "rgba(94, 62, 42, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
