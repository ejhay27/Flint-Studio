import * as THREE from 'three';
import { parse, type Font } from 'opentype.js';

/** Parse an imported/offline font binary into an opentype font object. */
export function parseOutlineFont(data: ArrayBuffer): Font | null {
  try {
    return parse(data) ?? null;
  } catch {
    return null;
  }
}

export type OutlinePath = { d: string; width: number; height: number };

/** Glyph paths with a per-character fallback for fonts whose GSUB tables opentype.js cannot shape. */
function safePaths(font: Font, text: string, size: number) {
  try {
    return font.getPaths(text || ' ', 0, 0, size);
  } catch {
    const paths: any[] = [];
    let x = 0;
    const units = font.unitsPerEm || 1000;
    for (const ch of Array.from(text || ' ')) {
      try {
        const glyph = font.charToGlyph(ch);
        if (glyph) {
          if (glyph.getPath) paths.push(glyph.getPath(x, 0, size));
          x += ((glyph.advanceWidth || units * 0.5) / units) * size;
        }
      } catch {
        x += size * 0.5;
      }
    }
    return paths;
  }
}

export function safeAdvanceWidth(font: Font, text: string, size: number) {
  try {
    return font.getAdvanceWidth(text || ' ', size);
  } catch {
    const units = font.unitsPerEm || 1000;
    let total = 0;
    for (const ch of Array.from(text || ' ')) {
      try {
        const glyph = font.charToGlyph(ch);
        total += ((glyph?.advanceWidth || units * 0.5) / units) * size;
      } catch {
        total += size * 0.5;
      }
    }
    return total;
  }
}

/**
 * Build genuine glyph outlines as an SVG path string, fitted into the same
 * 360-unit space that Flint uses for vector shapes.
 */
export function outlinePath(font: Font, text: string, units = 360): OutlinePath {
  const size = 100;
  const paths = safePaths(font, text, size);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    const bb = p.getBoundingBox();
    minX = Math.min(minX, bb.x1); minY = Math.min(minY, bb.y1);
    maxX = Math.max(maxX, bb.x2); maxY = Math.max(maxY, bb.y2);
  }
  if (!isFinite(minX)) return { d: '', width: 0, height: 0 };
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const k = (units * 0.94) / w;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const tx = (x: number) => ((x - cx) * k).toFixed(2);
  const ty = (y: number) => ((y - cy) * k).toFixed(2);
  let d = '';
  for (const p of paths) {
    for (const c of p.commands as any[]) {
      if (c.type === 'M') d += `M${tx(c.x)} ${ty(c.y)}`;
      else if (c.type === 'L') d += `L${tx(c.x)} ${ty(c.y)}`;
      else if (c.type === 'Q') d += `Q${tx(c.x1)} ${ty(c.y1)} ${tx(c.x)} ${ty(c.y)}`;
      else if (c.type === 'C') d += `C${tx(c.x1)} ${ty(c.y1)} ${tx(c.x2)} ${ty(c.y2)} ${tx(c.x)} ${ty(c.y)}`;
      else if (c.type === 'Z') d += 'Z';
    }
  }
  return { d, width: w * k, height: h * k };
}

function shapePathFromFont(font: Font, text: string, size: number) {
  const sp = new THREE.ShapePath();
  sp.moveTo(0, 0);
  for (const p of safePaths(font, text, size)) {
    for (const c of p.commands as any[]) {
      if (c.type === 'M') sp.moveTo(c.x, -c.y);
      else if (c.type === 'L') sp.lineTo(c.x, -c.y);
      else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
      else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
      else if (c.type === 'Z') sp.currentPath?.closePath();
    }
  }
  return sp;
}

/** Real extruded glyph geometry for 3D text. Returns null when outlines are unusable. */
export function textExtrudeGeometry(font: Font, text: string, size: number, depth: number, bevel: number): THREE.ExtrudeGeometry | null {
  try {
    const shapes = shapePathFromFont(font, text, size).toShapes();
    if (!shapes.length) return null;
    const b = Math.min(Math.max(0, bevel), Math.max(0, depth) / 2, 12);
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: Math.max(0.5, depth),
      bevelEnabled: b > 0,
      bevelThickness: b,
      bevelSize: b,
      bevelSegments: 2,
      curveSegments: 10,
    });
    geo.center();
    return geo;
  } catch {
    return null;
  }
}

/** Flat glyph-outline geometry (no extrusion) used when depth is zero. */
export function textFlatGeometry(font: Font, text: string, size: number) {
  try {
    const shapes = shapePathFromFont(font, text, size).toShapes();
    if (!shapes.length) return null;
    const geo = new THREE.ShapeGeometry(shapes, 8);
    geo.center();
    return geo;
  } catch {
    return null;
  }
}
