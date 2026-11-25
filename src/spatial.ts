import * as THREE from 'three';

/** Editable, centered 360-unit vector profiles used by the extrusion renderer. */
export function extrudedPath(shape: string, depth: number, bevel: number) {
  const s = new THREE.Shape();
  const r = 180;
  if (shape === 'circle' || shape === 'ellipse') s.absellipse(0, 0, r, r, 0, Math.PI * 2, false, 0);
  else if (shape === 'triangle') { s.moveTo(0, r); s.lineTo(-r, -r); s.lineTo(r, -r); s.closePath(); }
  else if (shape === 'diamond') { s.moveTo(0, r); s.lineTo(r, 0); s.lineTo(0, -r); s.lineTo(-r, 0); s.closePath(); }
  else if (shape === 'star') { for (let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,rr=i%2?r*.45:r;s[i===0?'moveTo':'lineTo'](Math.cos(a)*rr,Math.sin(a)*rr)} s.closePath(); }
  else if (shape === 'heart') { s.moveTo(0,-r*.8);s.bezierCurveTo(-r*1.3,-r*.1,-r*.65,r*.8,0,r*.25);s.bezierCurveTo(r*.65,r*.8,r*1.3,-r*.1,0,-r*.8);s.closePath(); }
  else if (shape === 'arrow') { s.moveTo(-r,-r*.2);s.lineTo(r*.15,-r*.2);s.lineTo(r*.15,-r*.55);s.lineTo(r,r*.05);s.lineTo(r*.15,r*.65);s.lineTo(r*.15,r*.25);s.lineTo(-r,r*.25);s.closePath(); }
  else if (shape === 'cross') { s.moveTo(-r*.2,-r);s.lineTo(r*.2,-r);s.lineTo(r*.2,-r*.2);s.lineTo(r,-r*.2);s.lineTo(r,r*.2);s.lineTo(r*.2,r*.2);s.lineTo(r*.2,r);s.lineTo(-r*.2,r);s.lineTo(-r*.2,r*.2);s.lineTo(-r,r*.2);s.lineTo(-r,-r*.2);s.lineTo(-r*.2,-r*.2);s.closePath(); }
  else if (shape === 'ring') { s.absellipse(0,0,r,r,0,Math.PI*2,false);const h=new THREE.Path();h.absellipse(0,0,r*.55,r*.55,0,Math.PI*2,true);s.holes.push(h); }
  else if (shape === 'rounded rectangle') s.moveTo(-r,-r).lineTo(r,-r).lineTo(r,r).lineTo(-r,r).closePath();
  else s.moveTo(-r,-r).lineTo(r,-r).lineTo(r,r).lineTo(-r,r).closePath();
  const amount=Math.max(0,depth),b=Math.min(Math.max(0,bevel),amount/2,16);
  const geometry=new THREE.ExtrudeGeometry(s,{depth:amount,bevelEnabled:b>0,bevelThickness:b,bevelSize:b,bevelSegments:2,curveSegments:24});
  geometry.translate(0,0,-amount/2);
  return geometry;
}
