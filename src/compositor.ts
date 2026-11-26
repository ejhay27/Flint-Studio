import * as THREE from 'three';
import { compileEffectStack } from './effects';

/**
 * Flint GPU compositor.
 *
 * One scene, one camera, many passes: every layer is rendered into its own
 * render target through the *existing* Three.js material (so shader effects,
 * lighting, extrusion and camera motion keep working), then composited with
 * its mask, track matte, corner pin, blend mode and opacity in screen space.
 * Adjustment layers run as full-screen effect passes over the accumulation
 * buffer, which is what makes "only the layers beneath me" correct.
 *
 * Canvas2D is still used for mask/matte rasterisation and pre-comp flattening,
 * but it never replaces the GPU path any more.
 */

export type Pt = { x: number; y: number };

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'difference'
  | 'add';

export const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'difference',
  'add',
];

export type MatteKind = 'alpha' | 'alpha-inverted' | 'luminance' | 'luminance-inverted';

const MATTE_CODES: Record<MatteKind, number> = {
  alpha: 0,
  'alpha-inverted': 1,
  luminance: 2,
  'luminance-inverted': 3,
};

export type MaskRef = { texture: THREE.Texture; invert?: boolean };

/** Pre-baked effect stack uniforms (built by the caller from EFFECTS). */
export type EffectUniforms = {
  count: number;
  types: number[];
  params: THREE.Vector4[];
  colors: THREE.Vector3[];
  key: string;
};

export type LayerPass = {
  id: string;
  objects: THREE.Object3D[];
  opacity?: number;
  blend?: BlendMode;
  mask?: MaskRef | null;
  matte?: { sourceId: string; type: MatteKind } | null;
  /** Composition-space corner pin (destination quad of the full frame). */
  pin?: { tl: Pt; tr: Pt; br: Pt; bl: Pt } | null;
  /** Effect stack applied to this layer's own pass (used for pre-comps). */
  effects?: EffectUniforms | null;
};

export type AdjustmentPass = {
  id: string;
  effects: EffectUniforms | null;
  opacity?: number;
  mask?: MaskRef | null;
  blend?: BlendMode;
};

export type RenderItem = ({ type: 'layer' } & LayerPass) | ({ type: 'adjustment' } & AdjustmentPass);

export type RenderOptions = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  items: RenderItem[];
  width: number;
  height: number;
  background: string | null;
  /** Composition buffer scale (1 = full resolution). */
  scale?: number;
  /** Editor helpers (null/camera axes) that stay visible in every pass. */
  always?: THREE.Object3D[];
};

export type CompositorStats = {
  mode: 'direct' | 'composite';
  passes: number;
  targets: number;
  textureBytes: number;
  layers: number;
  adjustments: number;
  maskTextures: number;
  frameMs: number;
  shaderErrors: string[];
  maxTextureSize: number;
  floatTargets: boolean;
};

/* ------------------------------------------------------------------ math */

/** Solve the 3x3 homography that maps the unit square to a quad (Sutherland). */
export function squareToQuad(q: [Pt, Pt, Pt, Pt]): number[] {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/** Invert a row-major 3x3 matrix (returns identity when singular). */
export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const id = 1 / det;
  return [
    A * id,
    -(b * i - c * h) * id,
    (b * f - c * e) * id,
    B * id,
    (a * i - c * g) * id,
    -(a * f - c * d) * id,
    C * id,
    -(a * h - b * g) * id,
    (a * e - b * d) * id,
  ];
}

/**
 * Destination-screen UV -> source UV matrix for a corner pin.
 * Pin points are composition pixels; the returned mat3 is GL column-major ready.
 */
export function pinMatrix(pin: { tl: Pt; tr: Pt; br: Pt; bl: Pt }, width: number, height: number): number[] | null {
  const nx = (p: Pt) => ({ x: p.x / Math.max(1, width), y: 1 - p.y / Math.max(1, height) });
  // unit square corner (0,0) is bottom-left in UV space
  const quad: [Pt, Pt, Pt, Pt] = [nx(pin.bl), nx(pin.br), nx(pin.tr), nx(pin.tl)];
  const spanX = Math.max(...quad.map(p => p.x)) - Math.min(...quad.map(p => p.x));
  const spanY = Math.max(...quad.map(p => p.y)) - Math.min(...quad.map(p => p.y));
  if (!(spanX > 1e-5) || !(spanY > 1e-5)) return null;
  const fwd = squareToQuad(quad);
  return invert3(fwd);
}

/** Column-major mat3 for a GLSL uniform. */
export function matrixToGL(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** CPU mirror of the shader blend, used by the render regression tests. */
export function blendPixel(
  dst: [number, number, number, number],
  src: [number, number, number, number],
  mode: BlendMode,
): [number, number, number, number] {
  const b = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = dst[i],
      s = src[i];
    switch (mode) {
      case 'multiply':
        b[i] = d * s;
        break;
      case 'screen':
        b[i] = 1 - (1 - d) * (1 - s);
        break;
      case 'overlay':
        b[i] = d <= 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s);
        break;
      case 'darken':
        b[i] = Math.min(d, s);
        break;
      case 'lighten':
        b[i] = Math.max(d, s);
        break;
      case 'difference':
        b[i] = Math.abs(d - s);
        break;
      case 'add':
        b[i] = Math.min(1, d + s);
        break;
      default:
        b[i] = s;
    }
  }
  const as = clamp01(src[3]),
    ad = clamp01(dst[3]);
  const ao = as + ad * (1 - as);
  const out: [number, number, number, number] = [0, 0, 0, ao];
  for (let i = 0; i < 3; i++) {
    const co = as * (1 - ad) * src[i] + as * ad * b[i] + (1 - as) * ad * dst[i];
    out[i] = ao > 1e-4 ? clamp01(co / ao) : 0;
  }
  return out;
}

export function luminance(rgb: [number, number, number]): number {
  return clamp01(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
}

/* --------------------------------------------------------------- shaders */

const QUAD_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON_BLEND = `
vec4 flintBlend(vec4 d, vec4 s, int mode){
  vec3 b = s.rgb;
  if(mode==1) b = d.rgb * s.rgb;
  else if(mode==2) b = 1.0 - (1.0 - d.rgb) * (1.0 - s.rgb);
  else if(mode==3) b = mix(2.0*d.rgb*s.rgb, 1.0 - 2.0*(1.0-d.rgb)*(1.0-s.rgb), step(0.5, d.rgb));
  else if(mode==4) b = min(d.rgb, s.rgb);
  else if(mode==5) b = max(d.rgb, s.rgb);
  else if(mode==6) b = abs(d.rgb - s.rgb);
  else if(mode==7) b = min(d.rgb + s.rgb, vec3(1.0));
  float as = clamp(s.a, 0.0, 1.0);
  float ad = clamp(d.a, 0.0, 1.0);
  float ao = as + ad * (1.0 - as);
  vec3 co = as*(1.0-ad)*s.rgb + as*ad*b + (1.0-as)*ad*d.rgb;
  return vec4(ao > 0.0001 ? co/ao : vec3(0.0), ao);
}
`;

export const COMPOSITE_FRAG = `
varying vec2 vUv;
uniform sampler2D tLayer;
uniform sampler2D tDst;
uniform sampler2D tMask;
uniform sampler2D tMatte;
uniform int uHasMask;
uniform int uMaskInvert;
uniform int uHasMatte;
uniform int uMatteType;
uniform int uHasPin;
uniform mat3 uPinInv;
uniform float uOpacity;
uniform int uBlend;
uniform int uUseDst;
${COMMON_BLEND}
void main(){
  vec2 suv = vUv;
  if(uHasPin==1){
    vec3 p = uPinInv * vec3(vUv, 1.0);
    suv = p.xy / max(0.00001, p.z);
    if(suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0){ gl_FragColor = vec4(0.0); return; }
  }
  vec4 src = texture2D(tLayer, suv);
  float m = 1.0;
  if(uHasMask==1){
    float a = texture2D(tMask, vUv).a;
    m *= (uMaskInvert==1) ? (1.0 - a) : a;
  }
  if(uHasMatte==1){
    vec4 mc = texture2D(tMatte, vUv);
    float lv = dot(mc.rgb, vec3(0.299, 0.587, 0.114));
    float v = (uMatteType==0 || uMatteType==1) ? mc.a : lv;
    m *= (uMatteType==0 || uMatteType==2) ? v : (1.0 - v);
  }
  src.a *= clamp(m, 0.0, 1.0) * uOpacity;
  if(uUseDst==0){ gl_FragColor = src; return; }
  gl_FragColor = flintBlend(texture2D(tDst, vUv), src, uBlend);
}
`;

export const BLIT_FRAG = `
varying vec2 vUv;
uniform sampler2D tSrc;
void main(){ gl_FragColor = texture2D(tSrc, vUv); }
`;

export const EFFECT_PASS_FRAG = `
varying vec2 vUv;
uniform sampler2D tInput;
#define map tInput
${compileEffectStack()}
void main(){
  vec4 src = texture2D(tInput, vUv);
  gl_FragColor = flintApply(src, vUv);
}
`;

/* ------------------------------------------------------------- resources */

type Target = { rt: THREE.WebGLRenderTarget; w: number; h: number };

const stackReady = (fx: EffectUniforms | null | undefined) => !!(fx && fx.count > 0);

export class FlintCompositor {
  private renderer: THREE.WebGLRenderer;
  private a: Target | null = null;
  private b: Target | null = null;
  private layerRT: Target | null = null;
  private matteRT: Target | null = null;
  private fxRT: Target | null = null;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private compMat: THREE.ShaderMaterial;
  private blitMat: THREE.ShaderMaterial;
  private effectMats = new Map<string, THREE.ShaderMaterial>();
  private linear = true;
  private floatTargets = false;
  private maxTextureSize = 2048;

  stats: CompositorStats = {
    mode: 'direct',
    passes: 0,
    targets: 0,
    textureBytes: 0,
    layers: 0,
    adjustments: 0,
    maskTextures: 0,
    frameMs: 0,
    shaderErrors: [],
    maxTextureSize: 2048,
    floatTargets: false,
  };

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const anyRenderer = renderer as unknown as {
      getContext?: () => WebGLRenderingContext | null;
      capabilities?: { isWebGL2?: boolean };
    };
    const gl = typeof anyRenderer.getContext === 'function' ? anyRenderer.getContext() : null;
    this.maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048 : 2048;
    this.floatTargets = !!(
      gl &&
      anyRenderer.capabilities?.isWebGL2 &&
      typeof gl.getExtension === 'function' &&
      gl.getExtension('EXT_color_buffer_float')
    );
    this.linear = true;

    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tLayer: { value: null },
        tDst: { value: null },
        tMask: { value: null },
        tMatte: { value: null },
        uHasMask: { value: 0 },
        uMaskInvert: { value: 0 },
        uHasMatte: { value: 0 },
        uMatteType: { value: 0 },
        uHasPin: { value: 0 },
        uPinInv: { value: new THREE.Matrix3() },
        uOpacity: { value: 1 },
        uBlend: { value: 0 },
        uUseDst: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLIT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geo, this.blitMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.stats.maxTextureSize = this.maxTextureSize;
    this.stats.floatTargets = this.floatTargets;
  }

  get backend() {
    const caps = (this.renderer as unknown as { capabilities?: { isWebGL2?: boolean } }).capabilities;
    return `WebGL${caps?.isWebGL2 ? '2' : '1'}`;
  }

  private makeTarget(w: number, h: number, depth: boolean): Target {
    const type = this.linear ? THREE.UnsignedByteType : THREE.UnsignedByteType;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return { rt, w, h };
  }

  private disposeTarget(t: Target | null) {
    if (t) t.rt.dispose();
  }

  private ensureSize(w: number, h: number, quality: number) {
    const cap = Math.min(this.maxTextureSize, 4096);
    const scale = Math.min(quality, cap / Math.max(w, h));
    const tw = Math.max(2, Math.round(w * scale));
    const th = Math.max(2, Math.round(h * scale));
    if (!this.a || this.a.w !== tw || this.a.h !== th) {
      this.disposeTarget(this.a);
      this.disposeTarget(this.b);
      this.a = this.makeTarget(tw, th, false);
      this.b = this.makeTarget(tw, th, false);
    }
    if (!this.layerRT || this.layerRT.w !== tw || this.layerRT.h !== th) {
      this.disposeTarget(this.layerRT);
      this.disposeTarget(this.matteRT);
      this.disposeTarget(this.fxRT);
      this.layerRT = this.makeTarget(tw, th, true);
      this.matteRT = this.makeTarget(tw, th, true);
      this.fxRT = this.makeTarget(tw, th, false);
    }
    const bytes = tw * th * 4 * 5;
    this.stats.targets = 5;
    this.stats.textureBytes = bytes;
  }

  private effectMaterial(fx: EffectUniforms): THREE.ShaderMaterial {
    const sig = fx.key;
    const cached = this.effectMats.get(sig);
    if (cached) {
      cached.uniforms.flintEffectCount.value = fx.count;
      cached.uniforms.flintEffectTypes.value = fx.types.slice(0, 16);
      cached.uniforms.flintEffectParams.value = fx.params.slice(0, 16);
      cached.uniforms.flintEffectColors.value = fx.colors.slice(0, 16);
      return cached;
    }
    if (this.effectMats.size > 24) {
      const first = this.effectMats.keys().next().value;
      if (first) {
        const mat = this.effectMats.get(first);
        mat?.dispose();
        this.effectMats.delete(first);
      }
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        flintEffectCount: { value: fx.count },
        flintEffectTypes: { value: fx.types.slice(0, 16) },
        flintEffectParams: { value: fx.params.slice(0, 16) },
        flintEffectColors: { value: fx.colors.slice(0, 16) },
        flintFrame: { value: 0 },
        flintTransition: { value: new THREE.Vector4(0, 0, 0, 0) },
        flintTransitionColor: { value: new THREE.Vector3(0, 0, 0) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: EFFECT_PASS_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.effectMats.set(sig, mat);
    return mat;
  }

  /** Effect passes currently cached (diagnostics). */
  get effectMaterialCount() {
    return this.effectMats.size;
  }

  dispose() {
    this.disposeTarget(this.a);
    this.disposeTarget(this.b);
    this.disposeTarget(this.layerRT);
    this.disposeTarget(this.matteRT);
    this.disposeTarget(this.fxRT);
    this.a = this.b = this.layerRT = this.matteRT = this.fxRT = null;
    for (const m of this.effectMats.values()) m.dispose();
    this.effectMats.clear();
    this.compMat.dispose();
    this.blitMat.dispose();
    this.quad.geometry.dispose();
    this.stats.targets = 0;
    this.stats.textureBytes = 0;
    this.stats.layers = 0;
    this.stats.adjustments = 0;
  }

  private setVisibility(scene: THREE.Scene, keep: Set<THREE.Object3D>, always?: THREE.Object3D[]) {
    const extra = new Set(always || []);
    scene.traverse(o => {
      const anyO = o as unknown as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (anyO.isMesh || anyO.isPoints || anyO.isLine || anyO.isSprite) {
        o.visible = keep.has(o) || extra.has(o);
      }
    });
  }

  private renderObjects(
    opts: RenderOptions,
    objects: THREE.Object3D[],
    target: Target | null,
    clearAlpha: number,
  ) {
    this.setVisibility(opts.scene, new Set(objects), opts.always);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(target ? target.rt : null);
    r.setClearColor(0x000000, clearAlpha);
    r.clear(true, true, true);
    r.render(opts.scene, opts.camera);
    r.setRenderTarget(prevTarget);
    this.stats.passes++;
  }

  private drawQuad(material: THREE.Material, target: Target | null) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    this.quad.material = material;
    r.setRenderTarget(target ? target.rt : null);
    r.render(this.quadScene, this.quadCam);
    r.setRenderTarget(prevTarget);
    this.stats.passes++;
  }

  private composite(
    layerTex: THREE.Texture,
    dstTex: THREE.Texture | null,
    params: { mask?: MaskRef | null; matteTex?: THREE.Texture | null; matte?: MatteKind; pin?: { tl: Pt; tr: Pt; br: Pt; bl: Pt } | null; opacity: number; blend: BlendMode; width: number; height: number },
    out: Target,
  ) {
    const u = this.compMat.uniforms;
    u.tLayer.value = layerTex;
    u.tMask.value = params.mask ? params.mask.texture : null;
    u.uHasMask.value = params.mask ? 1 : 0;
    u.uMaskInvert.value = params.mask && params.mask.invert ? 1 : 0;
    u.tMatte.value = params.matteTex || null;
    u.uHasMatte.value = params.matteTex ? 1 : 0;
    u.uMatteType.value = MATTE_CODES[params.matte || 'alpha'];
    const pin = params.pin;
    const matrix = pin ? pinMatrix(pin, params.width, params.height) : null;
    if (matrix) {
      const m = matrixToGL(matrix);
      u.uPinInv.value.set(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);
      u.uHasPin.value = 1;
    } else {
      u.uHasPin.value = 0;
    }
    u.uOpacity.value = params.opacity;
    u.uBlend.value = Math.max(0, BLEND_MODES.indexOf(params.blend));
    u.uUseDst.value = dstTex ? 1 : 0;
    u.tDst.value = dstTex;
    this.drawQuad(this.compMat, out);
  }

  /**
   * Render one frame. Returns true when the layered path ran.
   * `direct` is used when nothing needs isolated passes, which keeps the
   * Phase 5 render cost identical for plain compositions.
   */
  render(opts: RenderOptions): boolean {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.stats.passes = 0;
    this.stats.maskTextures = 0;
    this.stats.layers = 0;
    this.stats.adjustments = 0;
    this.stats.shaderErrors = [];

    const layered = opts.items.some(
      i => i.type === 'adjustment' || i.mask || i.matte || (i.type === 'layer' && (i.pin || (i.blend && i.blend !== 'normal') || (i.effects && i.effects.count > 0))),
    );
    this.stats.mode = layered ? 'composite' : 'direct';

    const allObjects = opts.items.flatMap(i => (i.type === 'layer' ? i.objects : []));
    if (!layered) {
      this.setVisibility(opts.scene, new Set(allObjects), opts.always);
      const r = this.renderer;
      r.setRenderTarget(null);
      if (opts.background) r.setClearColor(new THREE.Color(opts.background), 1);
      else r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(opts.scene, opts.camera);
      this.stats.passes = 1;
      this.stats.frameMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return false;
    }

    const scale = Math.max(0.25, Math.min(1, opts.scale ?? 1));
    this.ensureSize(opts.width, opts.height, scale);
    const a = this.a!,
      b = this.b!,
      layerRT = this.layerRT!,
      matteRT = this.matteRT!,
      fxTarget = this.fxRT!;

    // clear accumulation
    this.renderer.setRenderTarget(a.rt);
    if (opts.background) this.renderer.setClearColor(new THREE.Color(opts.background), 1);
    else this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.setRenderTarget(null);
    let acc = a;
    let other = b;

    const byId = new Map<string, LayerPass>();
    for (const item of opts.items) if (item.type === 'layer') byId.set(item.id, item);

    for (const item of opts.items) {
      if (item.type === 'adjustment') {
        if (!stackReady(item.effects)) continue;
        const mat = this.effectMaterial(item.effects!);
        const u = mat.uniforms;
        u.tInput.value = acc.rt.texture;
        u.flintFrame.value = 0;
        // render effect pass into `other`, then blend/copy back through composite
        this.drawQuad(mat, other);
        // composite the adjusted result over the untouched accumulation so masks
        // and opacity behave like any other layer pass
        this.composite(other.rt.texture, acc.rt.texture, {
          mask: item.mask || null,
          opacity: item.opacity ?? 1,
          blend: item.blend || 'normal',
          width: opts.width,
          height: opts.height,
        }, acc);
        this.stats.adjustments++;
        continue;
      }

      let matteTex: THREE.Texture | null = null;
      if (item.matte) {
        const src = byId.get(item.matte.sourceId);
        if (src && src.objects.length) {
          this.renderObjects(opts, src.objects, matteRT, 0);
          matteTex = matteRT.rt.texture;
        }
      }

      this.renderObjects(opts, item.objects, layerRT, 0);

      let layerTex: THREE.Texture = layerRT.rt.texture;
      if (stackReady(item.effects)) {
        const mat = this.effectMaterial(item.effects!);
        mat.uniforms.tInput.value = layerTex;
        this.drawQuad(mat, fxTarget);
        layerTex = fxTarget.rt.texture;
      }

      const blend = item.blend || 'normal';
      if (blend === 'normal') {
        // straight alpha over: hardware blending handles the maths
        this.compMat.blending = THREE.NormalBlending;
        this.compMat.depthTest = false;
        this.renderer.setRenderTarget(acc.rt);
        this.compMat.uniforms.tDst.value = null;
        this.composite(layerTex, null, {
          mask: item.mask || null,
          matteTex,
          matte: item.matte?.type,
          pin: item.pin || null,
          opacity: item.opacity ?? 1,
          blend,
          width: opts.width,
          height: opts.height,
        }, acc);
        this.compMat.blending = THREE.NoBlending;
      } else {
        this.composite(layerTex, acc.rt.texture, {
          mask: item.mask || null,
          matteTex,
          matte: item.matte?.type,
          pin: item.pin || null,
          opacity: item.opacity ?? 1,
          blend,
          width: opts.width,
          height: opts.height,
        }, other);
        const t = acc;
        acc = other;
        other = t;
      }
      this.stats.layers++;
    }

    // final blit to the visible canvas
    this.blitMat.uniforms.tSrc.value = acc.rt.texture;
    const r = this.renderer;
    r.setRenderTarget(null);
    if (opts.background) r.setClearColor(new THREE.Color(opts.background), 1);
    else r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    this.quad.material = this.blitMat;
    r.render(this.quadScene, this.quadCam);
    this.stats.passes++;
    this.stats.frameMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return true;
  }
}
