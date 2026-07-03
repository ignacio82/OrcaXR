import{G as bt,m as ee,d as S,n as lt,V as I,B as z,o as $,N as O,p as de,q as fe,b as ne,r as V,h as he,s as At,E as pe,t as me,u as xe,v as W,e as K,w as ie,x as ye,y as ve,c as ge,z as be,O as Ie,A as R,H as at,J as we,K as Be,Q as Ae,F as X,W as rt,X as Y,D as xt,Y as C,Z as _t,_ as _e,$ as Mt,a0 as Me,f as ct,a1 as yt,a2 as se,a3 as Se,a4 as Te,a5 as De,a6 as Pe,a7 as Ee,a8 as St,a9 as Ne,aa as He,ab as Fe,ac as Ve,ad as ze,ae as ke,j as Ce,l as It}from"./index-BIz0gl25.js";import{af as Tn,ag as Dn,ah as Pn,ai as En,aj as Nn,ak as Hn,al as Fn,am as Vn,an as zn,ao as kn,ap as Cn,aq as On}from"./index-BIz0gl25.js";const Tt=new S,j=new lt,Dt=new ee(()=>new de),ut=new I,Pt=new I,Et=new z,Nt=["getX","getY","getZ"];class Oe extends bt{get primitiveStride(){return 2}writePrimitiveBounds(e,t,n){const i=this._indirectBuffer,{geometry:r,primitiveStride:a}=this,l=r.attributes.position,u=r.index,s=u?u.count:l.count;let o=(i?i[e]:e)*a,f=(o+1)%s;u&&(o=u.getX(o),f=u.getX(f));for(let h=0;h<3;h++){const p=l[Nt[h]](o),m=l[Nt[h]](f),x=p<m?p:m,y=p>m?p:m;t[n+h]=x,t[n+h+3]=y}return t}shapecast(e){const t=Dt.getPrimitive(),n=super.shapecast({...e,intersectsPrimitive:e.intersectsLine,scratchPrimitive:t,iterate:We});return Dt.releasePrimitive(t),n}raycastObject3D(e,t,n=[]){const{matrixWorld:i}=e,{firstHitOnly:r}=t;Tt.copy(i).invert(),j.copy(t.ray).applyMatrix4(Tt);const l=t.params.Line.threshold/((e.scale.x+e.scale.y+e.scale.z)/3),u=l*l;let s=null,d=1/0;return this.shapecast({boundsTraverseOrder:o=>o.distanceToPoint(j.origin),intersectsBounds:o=>(Et.copy(o).expandByScalar(Math.abs(l)),j.intersectsBox(Et)?$:O),intersectsLine:(o,f)=>{if(j.distanceSqToSegment(o.start,o.end,ut,Pt)>u)return;ut.applyMatrix4(e.matrixWorld);const p=t.ray.origin.distanceTo(ut);p<t.near||p>t.far||r&&p>=d||(d=p,f=this.resolvePrimitiveIndex(f),s={distance:p,point:Pt.clone().applyMatrix4(i),index:f*this.primitiveStride,face:null,faceIndex:null,barycoord:null,object:e},r||n.push(s))}}),r&&s&&n.push(s),n}}class Re extends Oe{get primitiveStride(){return 1}constructor(e,t={}){t={...t,indirect:!0},super(e,t)}}class un extends Re{getRootRanges(...e){const t=super.getRootRanges(...e);return t.forEach(n=>n.count--),t}}function We(c,e,t,n,i,r,a){const{geometry:l,primitiveStride:u}=t,{index:s}=l,d=l.attributes.position,o=s?s.count:d.count;for(let f=c,h=e+c;f<h;f++){let m=t.resolvePrimitiveIndex(f)*u,x=(m+1)%o;if(s&&(m=s.getX(m),x=s.getX(x)),a.start.fromBufferAttribute(d,m),a.end.fromBufferAttribute(d,x),n(a,f,i,r))return!0}return!1}const Ht=new S,q=new lt,Ft=new ee(()=>new I),Vt=new z;class dn extends bt{get primitiveStride(){return 1}writePrimitiveBounds(e,t,n){const i=this._indirectBuffer,{geometry:r}=this,a=r.attributes.position,l=r.index;let u=i?i[e]:e;l&&(u=l.getX(u));const s=a.getX(u),d=a.getY(u),o=a.getZ(u);return t[n+0]=s,t[n+1]=d,t[n+2]=o,t[n+3]=s,t[n+4]=d,t[n+5]=o,t}shapecast(e){const t=Ft.getPrimitive(),n=super.shapecast({...e,intersectsPrimitive:e.intersectsPoint,scratchPrimitive:t,iterate:qe});return Ft.releasePrimitive(t),n}raycastObject3D(e,t,n=[]){const{geometry:i}=this,{matrixWorld:r}=e,{firstHitOnly:a}=t;Ht.copy(r).invert(),q.copy(t.ray).applyMatrix4(Ht);const u=t.params.Points.threshold/((e.scale.x+e.scale.y+e.scale.z)/3),s=u*u;let d=null,o=1/0;return this.shapecast({boundsTraverseOrder:f=>f.distanceToPoint(q.origin),intersectsBounds:f=>(Vt.copy(f).expandByScalar(Math.abs(u)),q.intersectsBox(Vt)?$:O),intersectsPoint:(f,h)=>{const p=q.distanceSqToPoint(f);if(p<s){const m=new I;q.closestPointToPoint(f,m),m.applyMatrix4(r);const x=t.ray.origin.distanceTo(m);if(x<t.near||x>t.far||a&&x>=o)return;o=x,h=this.resolvePrimitiveIndex(h),d={distance:x,distanceToRay:Math.sqrt(p),point:m,index:i.index?i.index.getX(h):h,face:null,faceIndex:null,barycoord:null,object:e},a||n.push(d)}}}),a&&d&&n.push(d),n}}function qe(c,e,t,n,i,r,a){const{geometry:l}=t,{index:u}=l,s=l.attributes.position;for(let d=c,o=e+c;d<o;d++){const f=t.resolvePrimitiveIndex(d),h=u?u.array[f]:f;if(a.fromBufferAttribute(s,h),n(a,d,i,r))return!0}return!1}const A=new V,w=new S,J=new S,zt=new z,k=new he,T=new I,Q=new lt,_=new ne,kt={};class fn extends fe{constructor(e,t={}){t={precise:!1,includeInstances:!0,matrixWorld:Array.isArray(e)?new S:e.matrixWorld,maxLeafSize:1,...t},super();const n=new Set;oe(e,n);const i=Array.from(n),r=Math.ceil(Math.log2(i.length)),a=Le(r);this.objects=i,this.idBits=r,this.idMask=a,this.primitiveBuffer=null,this.primitiveBufferStride=1,this.precise=t.precise,this.includeInstances=t.includeInstances,this.matrixWorld=t.matrixWorld,this.init(t)}getObjectFromId(e){const{idMask:t,objects:n}=this,i=vt(e,t);return n[i]}getInstanceFromId(e){const{idMask:t,idBits:n}=this;return gt(e,n,t)}init(e){const{objects:t,idBits:n}=this;this.primitiveBuffer=new Uint32Array(this._countPrimitives(t)),this._fillPrimitiveBuffer(t,n,this.primitiveBuffer),super.init(e)}writePrimitiveBounds(e,t,n){const{primitiveBuffer:i}=this;J.copy(this.matrixWorld).invert(),this._getPrimitiveBoundingBox(i[e],J,zt);const{min:r,max:a}=zt;t[n+0]=r.x,t[n+1]=r.y,t[n+2]=r.z,t[n+3]=a.x,t[n+4]=a.y,t[n+5]=a.z}getRootRanges(){return[{offset:0,count:this.primitiveBuffer.length}]}shapecast(e){return super.shapecast({...e,intersectsPrimitive:e.intersectsObject,scratchPrimitive:null,iterate:Ue})}raycast(e,t=[]){const{matrixWorld:n,includeInstances:i}=this,{firstHitOnly:r}=e,a=[];J.copy(n).invert(),Q.copy(e.ray).applyMatrix4(J);let l=1/0,u=null;return this.shapecast({boundsTraverseOrder:s=>s.distanceToPoint(Q.origin),intersectsBounds:s=>r?Q.intersectBox(s,T)?(T.applyMatrix4(n),e.ray.origin.distanceTo(T)<l?$:O):O:Q.intersectsBox(s)?$:O,intersectsObject(s,d){if(s.visible){if(a.length=0,s.isInstancedMesh&&i)_.geometry=s.geometry,_.material=s.material,s.getMatrixAt(d,_.matrixWorld),_.matrixWorld.premultiply(s.matrixWorld),_.raycast(e,a),a.forEach(o=>{o.object=s,o.instanceId=d}),_.material=null;else if(s.isBatchedMesh&&i){if(!s.getVisibleAt(d))return;const o=s.getGeometryIdAt(d),f=s.getGeometryRangeAt(o,kt);A.index=s.geometry.index,A.attributes=s.geometry.attributes,A.setDrawRange(f.start,f.count),_.geometry=A,_.material=s.material,s.getMatrixAt(d,_.matrixWorld),_.matrixWorld.premultiply(s.matrixWorld),_.raycast(e,a),a.forEach(h=>{h.object=s,h.batchId=d}),_.material=null,A.index=null,A.attributes=null,A.setDrawRange(0,1/0)}else s.raycast(e,a);r?a.forEach(o=>{o.distance<l&&(l=o.distance,u=o)}):t.push(...a)}}}),r&&u&&t.push(u),t}_getPrimitiveBoundingBox(e,t,n){const{objects:i,idMask:r,idBits:a,precise:l,includeInstances:u}=this,s=vt(e,r),d=gt(e,a,r),o=i[s];if(!u&&(o.isInstancedMesh||o.isBatchedMesh))o.boundingBox||o.computeBoundingBox(),o.boundingSphere||o.computeBoundingSphere(),w.copy(o.matrixWorld).premultiply(t),k.copy(o.boundingSphere).applyMatrix4(w),n.copy(o.boundingBox).applyMatrix4(w),dt(n,k);else if(l)if(o.isInstancedMesh)o.getMatrixAt(d,w),w.premultiply(o.matrixWorld).premultiply(t),Ct(o.geometry,w,n);else if(o.isBatchedMesh){const f=o.getGeometryIdAt(d),h=o.getGeometryRangeAt(f,kt);A.index=o.geometry.index,A.attributes=o.geometry.attributes,A.setDrawRange(h.start,h.count),o.getMatrixAt(d,w),w.premultiply(o.matrixWorld).premultiply(t),Ct(A,w,n),A.attributes=null}else w.copy(o.matrixWorld).premultiply(t),n.setFromObject(o,!0).applyMatrix4(t);else if(o.isInstancedMesh)o.geometry.boundingBox||o.geometry.computeBoundingBox(),o.geometry.boundingSphere||o.geometry.computeBoundingSphere(),o.getMatrixAt(d,w),w.premultiply(o.matrixWorld).premultiply(t),k.copy(o.geometry.boundingSphere).applyMatrix4(w),n.copy(o.geometry.boundingBox).applyMatrix4(w),dt(n,k);else if(o.isBatchedMesh){const f=o.getGeometryIdAt(d);o.getMatrixAt(d,w),w.premultiply(o.matrixWorld).premultiply(t),o.getBoundingSphereAt(f,k).applyMatrix4(w),o.getBoundingBoxAt(f,n).applyMatrix4(w),dt(n,k)}else n.setFromObject(o,!1).applyMatrix4(t)}_countPrimitives(e){const{includeInstances:t}=this;let n=0;return e.forEach(i=>{if(i.isInstancedMesh&&t)n+=i.count;else if(i.isBatchedMesh&&t){if(!("instanceCount"in i))throw new Error("ObjectBVH: Three.js revision >= r169 is required to use BatchedMesh.");n+=i.instanceCount}else n++}),n}_fillPrimitiveBuffer(e,t,n){const{includeInstances:i}=this;let r=0;e.forEach((a,l)=>{if(a.isInstancedMesh&&i){const u=a.count;for(let s=0;s<u;s++)n[r]=s<<t|l,r++}else if(a.isBatchedMesh&&i){const{instanceCount:u,maxInstanceCount:s}=a;let d=0,o=0;for(;d<u&&o<s;){try{a.getVisibleAt(o),n[r]=o<<t|l,d++,r++}catch{}o++}}else n[r]=l,r++})}}function Le(c){let e=0;for(let t=0;t<c;t++)e=e<<1|1;return e}function vt(c,e){return c&e}function gt(c,e,t){return(c&~t)>>e}function oe(c,e=new Set){Array.isArray(c)?c.forEach(t=>oe(t,e)):c.traverse(t=>{(t.isMesh||t.isLine||t.isPoints)&&e.add(t)})}function Ct(c,e,t){t.makeEmpty();const n=c.drawRange,i=c.index,r=c.attributes.position,a=n.start,l=i?i.count:r.count,u=Math.min(l-a,n.count);for(let s=a,d=a+u;s<d;s++){let o=s;i&&(o=i.getX(o)),T.fromBufferAttribute(r,o).applyMatrix4(e),t.expandByPoint(T)}return t}function Ue(c,e,t,n,i,r){const{primitiveBuffer:a,objects:l,idMask:u,idBits:s}=t;for(let d=c,o=e+c;d<o;d++){const f=a[d],h=vt(f,u),p=gt(f,s,u),m=l[h];if(n(m,p,i,r))return!0}return!1}function dt(c,e){T.copy(e.center).addScalar(-e.radius),c.min.max(T),T.copy(e.center).addScalar(e.radius),c.max.min(T)}const Ot=new I,Rt=new I,Wt=new I,P=new lt,qt=new S,E=new I,Ge=["x","y","z"],tt=parseInt(ie)>=169,Xe=parseInt(ie)<=161,et=new K,nt=new K,it=new K,Lt=new I,Ut=new I,Gt=new I;class hn extends bt{get primitiveStride(){return 3}constructor(e,t={}){if(!e.isMesh)throw new Error("SkinnedMeshBVH: First argument must be a Mesh.");super(e.geometry,{...t,[At]:!0}),this.mesh=e,t[At]||this.init(t)}writePrimitiveBounds(e,t,n){const{mesh:i,geometry:r}=this,a=this._indirectBuffer,l=r.index?r.index.array:null,s=(a?a[e]:e)*3;let d=s+0,o=s+1,f=s+2;l&&(d=l[d],o=l[o],f=l[f]),i.getVertexPosition(d,Ot),i.getVertexPosition(o,Rt),i.getVertexPosition(f,Wt);for(let h=0;h<3;h++){const p=Ge[h],m=Ot[p],x=Rt[p],y=Wt[p];let g=m;x<g&&(g=x),y<g&&(g=y);let v=m;x>v&&(v=x),y>v&&(v=y),t[n+h]=g,t[n+h+3]=v}return t}shapecast(e){const t=new pe;return super.shapecast({...e,intersectsPrimitive:e.intersectsTriangle,scratchPrimitive:t,iterate:Ye})}raycastObject3D(e,t,n=[]){const{material:i}=e;if(i===void 0)return;const{matrixWorld:r}=e,{firstHitOnly:a}=t;qt.copy(r).invert(),P.copy(t.ray).applyMatrix4(qt);let l=null,u=1/0;return this.shapecast({boundsTraverseOrder:s=>s.distanceToPoint(P.origin),intersectsBounds:s=>P.intersectsBox(s)?$:O,intersectsTriangle:(s,d)=>{let o=null;if(i.side===me?o=P.intersectTriangle(s.a,s.b,s.c,!0,E):i.side===xe?o=P.intersectTriangle(s.c,s.b,s.a,!0,E):o=P.intersectTriangle(s.a,s.b,s.c,!1,E),!o)return;o=o.clone().applyMatrix4(r);const f=t.ray.origin.distanceTo(o);if(f>=t.near&&f<=t.far){if(a&&f>=u)return;const{geometry:h}=this,{index:p}=h,m=this.resolvePrimitiveIndex(d),x=m*3;let y=x+0,g=x+1,v=x+2;p&&(y=p.array[y],g=p.array[g],v=p.array[v]);const b={distance:f,point:o.clone(),object:e,uv:null,uv1:null,normal:null,face:{a:y,b:g,c:v,normal:W.getNormal(s.a,s.b,s.c,new I),materialIndex:0},faceIndex:m};if(tt){const D=new I;W.getBarycoord(E,s.a,s.b,s.c,D),b.barycoord=D}const B=h.attributes.uv,M=h.attributes.uv1,Z=h.attributes.normal;if(B){et.fromBufferAttribute(B,y),nt.fromBufferAttribute(B,g),it.fromBufferAttribute(B,v),b.uv=new K;const D=W.getInterpolation(E,s.a,s.b,s.c,et,nt,it,b.uv);tt||(b.uv=D)}if(M){et.fromBufferAttribute(M,y),nt.fromBufferAttribute(M,g),it.fromBufferAttribute(M,v),b.uv1=new K;const D=W.getInterpolation(E,s.a,s.b,s.c,et,nt,it,b.uv1);tt||(b.uv1=D),Xe&&(b.uv2=b.uv1)}if(Z){Lt.fromBufferAttribute(Z,y),Ut.fromBufferAttribute(Z,g),Gt.fromBufferAttribute(Z,v),b.normal=new I;const D=W.getInterpolation(E,s.a,s.b,s.c,Lt,Ut,Gt,b.normal);b.normal.dot(P.direction)>0&&b.normal.multiplyScalar(-1),tt||(b.normal=D)}u=b.distance,l=b,a||n.push(b)}}}),a&&l&&n.push(l),n}}function Ye(c,e,t,n,i,r,a){const{mesh:l,geometry:u}=t,s=u.index?u.index.array:null;for(let d=c,o=e+c;d<o;d++){const f=t.resolvePrimitiveIndex(d);let h=3*f+0,p=3*f+1,m=3*f+2;if(s&&(h=s[h],p=s[p],m=s[m]),l.getVertexPosition(h,a.a),l.getVertexPosition(p,a.b),l.getVertexPosition(m,a.c),a.needsUpdate=!0,n(a,d,i,r))return!0}return!1}const Xt=new z,Yt=new S,ft=new I;class $e extends Ie{get isMesh(){return!this.displayEdges}get isLineSegments(){return this.displayEdges}get isLine(){return this.displayEdges}getVertexPosition(...e){return ne.prototype.getVertexPosition.call(this,...e)}constructor(e,t,n=10,i=0){super(),this.material=t,this.geometry=new V,this.name="BVHRootHelper",this.depth=n,this.displayParents=!1,this.bvh=e,this.displayEdges=!0,this._group=i}raycast(){}update(){const e=this.bvh;this.geometry.dispose(),this.visible=!1,e&&(this.geometry=this.getGeometry(e),this.visible=!0)}getGeometry(e){const t=this._group;let n=null;if(t!==-1)n=this.getBVHBoundPositions(e,t);else{const a=e._roots.map((s,d)=>this.getBVHBoundPositions(e,d)),l=a.reduce((s,d)=>s+d.length,0);n=new Float32Array(l);let u=0;a.forEach(s=>{n.set(s,u),u+=s.length})}const i=this.getBVHBoundIndices(n),r=new V;return r.setIndex(new R(i,1,!1)),r.setAttribute("position",new R(n,3,!1)),r}getBVHBoundIndices(e){const t=e.length/24;let n,i;this.displayEdges?i=new Uint8Array([0,4,1,5,2,6,3,7,0,2,1,3,4,6,5,7,0,1,2,3,4,5,6,7]):i=new Uint8Array([0,1,2,2,1,3,4,6,5,6,7,5,1,4,5,0,4,1,2,3,6,3,7,6,0,2,4,2,6,4,1,5,3,3,5,7]),e.length>65535?n=new Uint32Array(i.length*t):n=new Uint16Array(i.length*t);const r=i.length;for(let a=0;a<t;a++){const l=a*8,u=a*r;for(let s=0;s<r;s++)n[u+s]=l+i[s]}return n}getBVHBoundPositions(e,t=0,n=null){const i=this.depth-1,r=this.displayParents;let a=0;e.traverse((s,d)=>{if(s>=i||d)return a++,!0;r&&a++},t);let l=0;const u=new Float32Array(24*a);return e.traverse((s,d,o)=>{const f=s>=i||d;if(f||r){at(0,o,Xt);const{min:h,max:p}=Xt;for(let m=-1;m<=1;m+=2){const x=m<0?h.x:p.x;for(let y=-1;y<=1;y+=2){const g=y<0?h.y:p.y;for(let v=-1;v<=1;v+=2){const b=v<0?h.z:p.z;ft.set(x,g,b),n&&ft.applyMatrix4(n),ft.toArray(u,l),l+=3}}}return f}},t),u}}class wt extends ye{get color(){return this.edgeMaterial.color}get opacity(){return this.edgeMaterial.opacity}set opacity(e){this.edgeMaterial.opacity=e,this.meshMaterial.opacity=e}get objectIndex(){return console.warn('BVHHelper: "objectIndex" has been renamed "instanceId".'),this.instanceId}set objectIndex(e){console.warn('BVHHelper: "objectIndex" has been renamed "instanceId".'),this.instanceId=e}constructor(e=null,t=null,n=10){e instanceof be&&(n=t||10,t=e,e=null),typeof t=="number"&&(n=t,t=null),super(),this.name="BVHHelper",this.depth=n,this.mesh=e,this.bvh=t,this.displayParents=!1,this.displayEdges=!0,this.instanceId=0,this._roots=[];const i=new ve({color:65416,transparent:!0,opacity:.3,depthWrite:!1}),r=new ge({color:65416,transparent:!0,opacity:.3,depthWrite:!1});r.color=i.color,this.edgeMaterial=i,this.meshMaterial=r,this.update()}update(){const e=this.mesh,t=this.instanceId;let n=this.bvh||e.boundsTree||e.geometry&&e.geometry.boundsTree||null;if(e&&e.isBatchedMesh&&e.boundsTrees&&!n&&t>=0){const r=e._drawInfo[t];r&&(n=e.boundsTrees[r.geometryIndex]||n)}const i=n?n._roots.length:0;for(;this._roots.length>i;){const r=this._roots.pop();r.geometry.dispose(),this.remove(r)}for(let r=0;r<i;r++){const{depth:a,edgeMaterial:l,meshMaterial:u,displayParents:s,displayEdges:d}=this;if(r>=this._roots.length){const f=new $e(n,l,a,r);this.add(f),this._roots.push(f)}const o=this._roots[r];o.bvh=n,o.depth=a,o.displayParents=s,o.displayEdges=d,o.material=d?l:u,o.update()}}updateMatrixWorld(...e){const t=this.mesh,n=this.parent,i=this.instanceId;t!==null&&(t.updateWorldMatrix(!0,!1),n?this.matrix.copy(n.matrixWorld).invert().multiply(t.matrixWorld):this.matrix.copy(t.matrixWorld),(t.isInstancedMesh||t.isBatchedMesh)&&i>=0&&(t.getMatrixAt(i,Yt),this.matrix.multiply(Yt)),this.matrix.decompose(this.position,this.quaternion,this.scale)),super.updateMatrixWorld(...e)}copy(e){this.depth=e.depth,this.mesh=e.mesh,this.bvh=e.bvh,this.opacity=e.opacity,this.color.copy(e.color)}clone(){return new wt().copy(this)}dispose(){this.edgeMaterial.dispose(),this.meshMaterial.dispose();const e=this.children;for(let t=0,n=e.length;t<n;t++)e[t].geometry.dispose()}}class pn extends wt{constructor(...e){console.warn("MeshBVHHelper: Class has been deprecated. Use BVHHelper instead."),super(...e)}}const ht=new z,L=new z;function $t(c){switch(typeof c){case"number":return 8;case"string":return c.length*2;case"boolean":return 4;default:return 0}}function Ke(c){return/(Uint|Int|Float)(8|16|32)Array/.test(c.constructor.name)}function Ze(c,e){const t={nodeCount:0,leafNodeCount:0,depth:{min:1/0,max:-1/0},primitives:{min:1/0,max:-1/0},splits:[0,0,0],surfaceAreaScore:0};return c.traverse((n,i,r,a,l)=>{const u=r[3]-r[0],s=r[4]-r[1],d=r[5]-r[2],o=2*(u*s+s*d+d*u);t.nodeCount++,i?(t.leafNodeCount++,t.depth.min=Math.min(n,t.depth.min),t.depth.max=Math.max(n,t.depth.max),t.primitives.min=Math.min(l,t.primitives.min),t.primitives.max=Math.max(l,t.primitives.max),t.surfaceAreaScore+=o*Be*l):(t.splits[a]++,t.surfaceAreaScore+=o*Ae)},e),t.primitives.min===1/0&&(t.primitives.min=0,t.primitives.max=0),t.depth.min===1/0&&(t.depth.min=0,t.depth.max=0),t}function mn(c){return c._roots.map((e,t)=>Ze(c,t))}function xn(c){const e=new Set,t=[c];let n=0;for(;t.length;){const i=t.pop();if(!e.has(i)){e.add(i);for(let r in i){if(!Object.hasOwn(i,r))continue;n+=$t(r);const a=i[r];a&&(typeof a=="object"||typeof a=="function")?Ke(a)||we()&&a instanceof SharedArrayBuffer||a instanceof ArrayBuffer?n+=a.byteLength:t.push(a):n+=$t(a)}}}return n}function yn(c){const e=[],t=new Float32Array(6);let n=!0;return c.traverse((i,r,a,l,u)=>{const s={depth:i,isLeaf:r,boundingData:a,offset:l,count:u};e[i]=s,at(0,a,ht);const d=e[i-1];if(r){c.writePrimitiveRangeBounds(l,u,t,0),L.min.set(t[0],t[1],t[2]),L.max.set(t[3],t[4],t[5]);const o=ht.containsBox(L);console.assert(o,"Leaf bounds does not fully contain primitives."),n=n&&o}if(d){at(0,d.boundingData,L);const o=L.containsBox(ht);console.assert(o,"Parent bounds does not fully contain child."),n=n&&o}}),n}function vn(c){const e=[];return c.traverse((t,n,i,r,a)=>{const l={bounds:at(0,i,new z)};n?(l.count=a,l.offset=r):(l.left=null,l.right=null),e[t]=l;const u=e[t-1];u&&(u.left===null?u.left=l:u.right=l)}),e[0]}function je(c){switch(c){case 1:return"R";case 2:return"RG";case 3:return"RGBA";case 4:return"RGBA"}throw new Error}function Je(c){switch(c){case 1:return De;case 2:return Te;case 3:return ct;case 4:return ct}}function Kt(c){switch(c){case 1:return Se;case 2:return se;case 3:return yt;case 4:return yt}}class Bt extends xt{constructor(){super(),this.minFilter=C,this.magFilter=C,this.generateMipmaps=!1,this.overrideItemSize=null,this._forcedType=null}updateFrom(e){const t=this.overrideItemSize,n=e.itemSize,i=e.count;if(t!==null){if(n*i%t!==0)throw new Error("VertexAttributeTexture: overrideItemSize must divide evenly into buffer length.");e.itemSize=t,e.count=i*n/t}const r=e.itemSize,a=e.count,l=e.normalized,u=e.array.constructor,s=u.BYTES_PER_ELEMENT;let d=this._forcedType,o=r;if(d===null)switch(u){case Float32Array:d=X;break;case Uint8Array:case Uint16Array:case Uint32Array:d=Y;break;case Int8Array:case Int16Array:case Int32Array:d=rt;break}let f,h,p,m,x=je(r);switch(d){case X:p=1,h=Je(r),l&&s===1?(m=u,x+="8",u===Uint8Array?f=_t:(f=Mt,x+="_SNORM")):(m=Float32Array,x+="32F",f=X);break;case rt:x+=s*8+"I",p=l?Math.pow(2,u.BYTES_PER_ELEMENT*8-1):1,h=Kt(r),s===1?(m=Int8Array,f=Mt):s===2?(m=Int16Array,f=Me):(m=Int32Array,f=rt);break;case Y:x+=s*8+"UI",p=l?Math.pow(2,u.BYTES_PER_ELEMENT*8-1):1,h=Kt(r),s===1?(m=Uint8Array,f=_t):s===2?(m=Uint16Array,f=_e):(m=Uint32Array,f=Y);break}o===3&&(h===ct||h===yt)&&(o=4);const y=Math.ceil(Math.sqrt(a))||1,g=o*y*y,v=new m(g),b=e.normalized;e.normalized=!1;for(let B=0;B<a;B++){const M=o*B;v[M]=e.getX(B)/p,r>=2&&(v[M+1]=e.getY(B)/p),r>=3&&(v[M+2]=e.getZ(B)/p,o===4&&(v[M+3]=1)),r>=4&&(v[M+3]=e.getW(B)/p)}e.normalized=b,this.internalFormat=x,this.format=h,this.type=f,this.image.width=y,this.image.height=y,this.image.data=v,this.needsUpdate=!0,this.dispose(),e.itemSize=n,e.count=i}}class Qe extends Bt{constructor(){super(),this._forcedType=Y}}class gn extends Bt{constructor(){super(),this._forcedType=rt}}class tn extends Bt{constructor(){super(),this._forcedType=X}}class bn{constructor(){this.index=new Qe,this.position=new tn,this.bvhBounds=new xt,this.bvhContents=new xt,this._cachedIndexAttr=null,this.index.overrideItemSize=3}updateFrom(e){const{geometry:t}=e;if(nn(e,this.bvhBounds,this.bvhContents),this.position.updateFrom(t.attributes.position),e.indirect){const n=e._indirectBuffer;if(this._cachedIndexAttr===null||this._cachedIndexAttr.count!==n.length)if(t.index)this._cachedIndexAttr=t.index.clone();else{const i=Pe(Ee(t));this._cachedIndexAttr=new R(i,1,!1)}en(t,n,this._cachedIndexAttr),this.index.updateFrom(this._cachedIndexAttr)}else this.index.updateFrom(t.index)}dispose(){const{index:e,position:t,bvhBounds:n,bvhContents:i}=this;e&&e.dispose(),t&&t.dispose(),n&&n.dispose(),i&&i.dispose()}}function en(c,e,t){const n=t.array,i=c.index?c.index.array:null;for(let r=0,a=e.length;r<a;r++){const l=3*r,u=3*e[r];for(let s=0;s<3;s++)n[l+s]=i?i[u+s]:u+s}}function nn(c,e,t){const n=c._roots;if(n.length!==1)throw new Error("MeshBVHUniformStruct: Multi-root BVHs not supported.");const i=n[0],r=new Uint16Array(i),a=new Uint32Array(i),l=new Float32Array(i),u=i.byteLength/St,s=2*Math.ceil(Math.sqrt(u/2)),d=new Float32Array(4*s*s),o=Math.ceil(Math.sqrt(u)),f=new Uint32Array(2*o*o);for(let h=0;h<u;h++){const p=h*St/4,m=p*2,x=ze(p);for(let y=0;y<3;y++)d[8*h+0+y]=l[x+0+y],d[8*h+4+y]=l[x+3+y];if(Ne(m,r)){const y=He(m,r),g=Fe(p,a),v=ke|y;f[h*2+0]=v,f[h*2+1]=g}else{const y=a[p+6],g=Ve(p,a);f[h*2+0]=g,f[h*2+1]=y}}e.image.data=d,e.image.width=s,e.image.height=s,e.format=ct,e.type=X,e.internalFormat="RGBA32F",e.minFilter=C,e.magFilter=C,e.generateMipmaps=!1,e.needsUpdate=!0,e.dispose(),t.image.data=f,t.image.width=o,t.image.height=o,t.format=se,t.type=Y,t.internalFormat="RG32UI",t.minFilter=C,t.magFilter=C,t.generateMipmaps=!1,t.needsUpdate=!0,t.dispose()}const N=new I,H=new I,F=new I,Zt=new It,st=new I,pt=new I,jt=new It,Jt=new It,ot=new S,Qt=new S;function U(c,e){if(!c&&!e)return;const t=c.count===e.count,n=c.normalized===e.normalized,i=c.array.constructor===e.array.constructor,r=c.itemSize===e.itemSize;if(!t||!n||!i||!r)throw new Error}function G(c,e=null){const t=c.array.constructor,n=c.normalized,i=c.itemSize,r=e===null?c.count:e;return new R(new t(i*r),i,n)}function re(c,e,t=0){if(c.isInterleavedBufferAttribute){const n=c.itemSize;for(let i=0,r=c.count;i<r;i++){const a=i+t;e.setX(a,c.getX(i)),n>=2&&e.setY(a,c.getY(i)),n>=3&&e.setZ(a,c.getZ(i)),n>=4&&e.setW(a,c.getW(i))}}else{const n=e.array,i=n.constructor,r=n.BYTES_PER_ELEMENT*c.itemSize*t;new i(n.buffer,r,c.array.length).set(c.array)}}function sn(c,e,t){const n=c.elements,i=e.elements;for(let r=0,a=i.length;r<a;r++)n[r]+=i[r]*t}function te(c,e,t){const n=c.skeleton,i=c.geometry,r=n.bones,a=n.boneInverses;jt.fromBufferAttribute(i.attributes.skinIndex,e),Jt.fromBufferAttribute(i.attributes.skinWeight,e),ot.elements.fill(0);for(let l=0;l<4;l++){const u=Jt.getComponent(l);if(u!==0){const s=jt.getComponent(l);Qt.multiplyMatrices(r[s].matrixWorld,a[s]),sn(ot,Qt,u)}}return ot.multiply(c.bindMatrix).premultiply(c.bindMatrixInverse),t.transformDirection(ot),t}function mt(c,e,t,n,i){st.set(0,0,0);for(let r=0,a=c.length;r<a;r++){const l=e[r],u=c[r];l!==0&&(pt.fromBufferAttribute(u,n),t?st.addScaledVector(pt,l):st.addScaledVector(pt.sub(i),l))}i.add(st)}function on(c,e={useGroups:!1,updateIndex:!1,skipAttributes:[]},t=new V){const n=c[0].index!==null,{useGroups:i=!1,updateIndex:r=!1,skipAttributes:a=[]}=e,l=new Set(Object.keys(c[0].attributes)),u={};let s=0;t.clearGroups();for(let d=0;d<c.length;++d){const o=c[d];let f=0;if(n!==(o.index!==null))throw new Error("StaticGeometryGenerator: All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.");for(const h in o.attributes){if(!l.has(h))throw new Error('StaticGeometryGenerator: All geometries must have compatible attributes; make sure "'+h+'" attribute exists among all geometries, or in none of them.');u[h]===void 0&&(u[h]=[]),u[h].push(o.attributes[h]),f++}if(f!==l.size)throw new Error("StaticGeometryGenerator: Make sure all geometries have the same number of attributes.");if(i){let h;if(n)h=o.index.count;else if(o.attributes.position!==void 0)h=o.attributes.position.count;else throw new Error("StaticGeometryGenerator: The geometry must have either an index or a position attribute");t.addGroup(s,h,d),s+=h}}if(n){let d=!1;if(!t.index){let o=0;for(let f=0;f<c.length;++f)o+=c[f].index.count;t.setIndex(new R(new Uint32Array(o),1,!1)),d=!0}if(r||d){const o=t.index;let f=0,h=0;for(let p=0;p<c.length;++p){const m=c[p],x=m.index;if(a[p]!==!0)for(let y=0;y<x.count;++y)o.setX(f,x.getX(y)+h),f++;h+=m.attributes.position.count}}}for(const d in u){const o=u[d];if(!(d in t.attributes)){let p=0;for(const m in o)p+=o[m].count;t.setAttribute(d,G(u[d][0],p))}const f=t.attributes[d];let h=0;for(let p=0,m=o.length;p<m;p++){const x=o[p];a[p]!==!0&&re(x,f,h),h+=x.count}}return t}function rn(c,e){if(c===null||e===null)return c===e;if(c.length!==e.length)return!1;for(let t=0,n=c.length;t<n;t++)if(c[t]!==e[t])return!1;return!0}function an(c){const{index:e,attributes:t}=c;if(e)for(let n=0,i=e.count;n<i;n+=3){const r=e.getX(n),a=e.getX(n+2);e.setX(n,a),e.setX(n+2,r)}else for(const n in t){const i=t[n],r=i.itemSize;for(let a=0,l=i.count;a<l;a+=3)for(let u=0;u<r;u++){const s=i.getComponent(a,u),d=i.getComponent(a+2,u);i.setComponent(a,u,d),i.setComponent(a+2,u,s)}}return c}class cn{constructor(e){this.matrixWorld=new S,this.geometryHash=null,this.boneMatrices=null,this.primitiveCount=-1,this.mesh=e,this.update()}update(){const e=this.mesh,t=e.geometry,n=e.skeleton,i=(t.index?t.index.count:t.attributes.position.count)/3;if(this.matrixWorld.copy(e.matrixWorld),this.geometryHash=t.attributes.position.version,this.primitiveCount=i,n){n.boneTexture||n.computeBoneTexture(),n.update();const r=n.boneMatrices;!this.boneMatrices||this.boneMatrices.length!==r.length?this.boneMatrices=r.slice():this.boneMatrices.set(r)}else this.boneMatrices=null}didChange(){const e=this.mesh,t=e.geometry,n=(t.index?t.index.count:t.attributes.position.count)/3;return!(this.matrixWorld.equals(e.matrixWorld)&&this.geometryHash===t.attributes.position.version&&rn(e.skeleton&&e.skeleton.boneMatrices||null,this.boneMatrices)&&this.primitiveCount===n)}}class In{constructor(e){Array.isArray(e)||(e=[e]);const t=[];e.forEach(n=>{n.traverseVisible(i=>{i.isMesh&&t.push(i)})}),this.meshes=t,this.useGroups=!0,this.applyWorldTransforms=!0,this.attributes=["position","normal","color","tangent","uv","uv2"],this._intermediateGeometry=new Array(t.length).fill().map(()=>new V),this._diffMap=new WeakMap}getMaterials(){const e=[];return this.meshes.forEach(t=>{Array.isArray(t.material)?e.push(...t.material):e.push(t.material)}),e}generate(e=new V){let t=[];const{meshes:n,useGroups:i,_intermediateGeometry:r,_diffMap:a}=this;for(let l=0,u=n.length;l<u;l++){const s=n[l],d=r[l],o=a.get(s);!o||o.didChange(s)?(this._convertToStaticGeometry(s,d),t.push(!1),o?o.update():a.set(s,new cn(s))):t.push(!0)}if(r.length===0){e.setIndex(null);const l=e.attributes;for(const u in l)e.deleteAttribute(u);for(const u in this.attributes)e.setAttribute(this.attributes[u],new R(new Float32Array(0),4,!1))}else on(r,{useGroups:i,skipAttributes:t},e);for(const l in e.attributes)e.attributes[l].needsUpdate=!0;return e}_convertToStaticGeometry(e,t=new V){const n=e.geometry,i=this.applyWorldTransforms,r=this.attributes.includes("normal"),a=this.attributes.includes("tangent"),l=n.attributes,u=t.attributes;!t.index&&n.index&&(t.index=n.index.clone()),u.position||t.setAttribute("position",G(l.position)),r&&!u.normal&&l.normal&&t.setAttribute("normal",G(l.normal)),a&&!u.tangent&&l.tangent&&t.setAttribute("tangent",G(l.tangent)),U(n.index,t.index),U(l.position,u.position),r&&U(l.normal,u.normal),a&&U(l.tangent,u.tangent);const s=l.position,d=r?l.normal:null,o=a?l.tangent:null,f=n.morphAttributes.position,h=n.morphAttributes.normal,p=n.morphAttributes.tangent,m=n.morphTargetsRelative,x=e.morphTargetInfluences,y=new Ce;y.getNormalMatrix(e.matrixWorld),n.index&&t.index.array.set(n.index.array);for(let g=0,v=l.position.count;g<v;g++)N.fromBufferAttribute(s,g),d&&H.fromBufferAttribute(d,g),o&&(Zt.fromBufferAttribute(o,g),F.fromBufferAttribute(o,g)),x&&(f&&mt(f,x,m,g,N),h&&mt(h,x,m,g,H),p&&mt(p,x,m,g,F)),e.isSkinnedMesh&&(e.applyBoneTransform(g,N),d&&te(e,g,H),o&&te(e,g,F)),i&&N.applyMatrix4(e.matrixWorld),u.position.setXYZ(g,N.x,N.y,N.z),d&&(i&&H.applyNormalMatrix(y),u.normal.setXYZ(g,H.x,H.y,H.z)),o&&(i&&F.transformDirection(e.matrixWorld),u.tangent.setXYZW(g,F.x,F.y,F.z,Zt.w));for(const g in this.attributes){const v=this.attributes[g];v==="position"||v==="tangent"||v==="normal"||!(v in l)||(u[v]||t.setAttribute(v,G(l[v])),U(l[v],u[v]),re(l[v],u[v]))}return e.matrixWorld.determinant()<0&&an(t),t}}const ae=`

// A stack of uint32 indices can can store the indices for
// a perfectly balanced tree with a depth up to 31. Lower stack
// depth gets higher performance.
//
// However not all trees are balanced. Best value to set this to
// is the trees max depth.
#ifndef BVH_STACK_DEPTH
#define BVH_STACK_DEPTH 60
#endif

#ifndef INFINITY
#define INFINITY 1e20
#endif

// Utilities
uvec4 uTexelFetch1D( usampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

ivec4 iTexelFetch1D( isampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 texelFetch1D( sampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 textureSampleBarycoord( sampler2D tex, vec3 barycoord, uvec3 faceIndices ) {

	return
		barycoord.x * texelFetch1D( tex, faceIndices.x ) +
		barycoord.y * texelFetch1D( tex, faceIndices.y ) +
		barycoord.z * texelFetch1D( tex, faceIndices.z );

}

void ndcToCameraRay(
	vec2 coord, mat4 cameraWorld, mat4 invProjectionMatrix,
	out vec3 rayOrigin, out vec3 rayDirection
) {

	// get camera look direction and near plane for camera clipping
	vec4 lookDirection = cameraWorld * vec4( 0.0, 0.0, - 1.0, 0.0 );
	vec4 nearVector = invProjectionMatrix * vec4( 0.0, 0.0, - 1.0, 1.0 );
	float near = abs( nearVector.z / nearVector.w );

	// get the camera direction and position from camera matrices
	vec4 origin = cameraWorld * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec4 direction = invProjectionMatrix * vec4( coord, 0.5, 1.0 );
	direction /= direction.w;
	direction = cameraWorld * direction - origin;

	// slide the origin along the ray until it sits at the near clip plane position
	origin.xyz += direction.xyz * near / dot( direction, lookDirection );

	rayOrigin = origin.xyz;
	rayDirection = direction.xyz;

}
`,ce=`

float dot2( vec3 v ) {

	return dot( v, v );

}

// https://www.shadertoy.com/view/ttfGWl
vec3 closestPointToTriangle( vec3 p, vec3 v0, vec3 v1, vec3 v2, out vec3 barycoord ) {

    vec3 v10 = v1 - v0;
    vec3 v21 = v2 - v1;
    vec3 v02 = v0 - v2;

	vec3 p0 = p - v0;
	vec3 p1 = p - v1;
	vec3 p2 = p - v2;

    vec3 nor = cross( v10, v02 );

    // method 2, in barycentric space
    vec3  q = cross( nor, p0 );
    float d = 1.0 / dot2( nor );
    float u = d * dot( q, v02 );
    float v = d * dot( q, v10 );
    float w = 1.0 - u - v;

	if( u < 0.0 ) {

		w = clamp( dot( p2, v02 ) / dot2( v02 ), 0.0, 1.0 );
		u = 0.0;
		v = 1.0 - w;

	} else if( v < 0.0 ) {

		u = clamp( dot( p0, v10 ) / dot2( v10 ), 0.0, 1.0 );
		v = 0.0;
		w = 1.0 - u;

	} else if( w < 0.0 ) {

		v = clamp( dot( p1, v21 ) / dot2( v21 ), 0.0, 1.0 );
		w = 0.0;
		u = 1.0 - v;

	}

	barycoord = vec3( u, v, w );
    return u * v1 + v * v2 + w * v0;

}

float distanceToTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// point and cut off range
	vec3 point, float closestDistanceSquared,

	// outputs
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord, inout float side, inout vec3 outPoint
) {

	bool found = false;
	vec3 localBarycoord;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		// get the closest point and barycoord
		vec3 closestPoint = closestPointToTriangle( point, a, b, c, localBarycoord );
		vec3 delta = point - closestPoint;
		float sqDist = dot2( delta );
		if ( sqDist < closestDistanceSquared ) {

			// set the output results
			closestDistanceSquared = sqDist;
			faceIndices = uvec4( indices.xyz, i );
			faceNormal = normalize( cross( a - b, b - c ) );
			barycoord = localBarycoord;
			outPoint = closestPoint;
			side = sign( dot( faceNormal, delta ) );

		}

	}

	return closestDistanceSquared;

}

float distanceSqToBounds( vec3 point, vec3 boundsMin, vec3 boundsMax ) {

	vec3 clampedPoint = clamp( point, boundsMin, boundsMax );
	vec3 delta = point - clampedPoint;
	return dot( delta, delta );

}

float distanceSqToBVHNodeBoundsPoint( vec3 point, sampler2D bvhBounds, uint currNodeIndex ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return distanceSqToBounds( point, boundsMin, boundsMax );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define	bvhClosestPointToPoint(		bvh,		point, maxDistance, faceIndices, faceNormal, barycoord, side, outPoint	)	_bvhClosestPointToPoint(		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,		point, maxDistance, faceIndices, faceNormal, barycoord, side, outPoint	)

float _bvhClosestPointToPoint(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// point to check
	vec3 point, float maxDistance,

	// output variables
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout vec3 outPoint
 ) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int pointer = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float closestDistanceSquared = maxDistance * maxDistance;
	bool found = false;
	while ( pointer > - 1 && pointer < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ pointer ];
		pointer --;

		// check if we intersect the current bounds
		float boundsHitDistance = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, currNodeIndex );
		if ( boundsHitDistance > closestDistanceSquared ) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );
		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;
			closestDistanceSquared = distanceToTriangles(
				bvh_position, bvh_index, offset, count, point, closestDistanceSquared,

				// outputs
				faceIndices, faceNormal, barycoord, side, outPoint
			);

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = currNodeIndex + boundsInfo.y;
			bool leftToRight = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, leftIndex ) < distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, rightIndex );//rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			pointer ++;
			stack[ pointer ] = c2;
			pointer ++;
			stack[ pointer ] = c1;

		}

	}

	return sqrt( closestDistanceSquared );

}
`,le=`

#ifndef TRI_INTERSECT_EPSILON
#define TRI_INTERSECT_EPSILON 1e-5
#endif

// Raycasting
bool intersectsBounds( vec3 rayOrigin, vec3 rayDirection, vec3 boundsMin, vec3 boundsMax, out float dist ) {

	// https://www.reddit.com/r/opengl/comments/8ntzz5/fast_glsl_ray_box_intersection/
	// https://tavianator.com/2011/ray_box.html
	vec3 invDir = 1.0 / rayDirection;

	// find intersection distances for each plane
	vec3 tMinPlane = invDir * ( boundsMin - rayOrigin );
	vec3 tMaxPlane = invDir * ( boundsMax - rayOrigin );

	// get the min and max distances from each intersection
	vec3 tMinHit = min( tMaxPlane, tMinPlane );
	vec3 tMaxHit = max( tMaxPlane, tMinPlane );

	// get the furthest hit distance
	vec2 t = max( tMinHit.xx, tMinHit.yz );
	float t0 = max( t.x, t.y );

	// get the minimum hit distance
	t = min( tMaxHit.xx, tMaxHit.yz );
	float t1 = min( t.x, t.y );

	// set distance to 0.0 if the ray starts inside the box
	dist = max( t0, 0.0 );

	return t1 >= dist;

}

bool intersectsTriangle(
	vec3 rayOrigin, vec3 rayDirection, vec3 a, vec3 b, vec3 c,
	out vec3 barycoord, out vec3 norm, out float dist, out float side
) {

	// https://stackoverflow.com/questions/42740765/intersection-between-line-and-triangle-in-3d
	vec3 edge1 = b - a;
	vec3 edge2 = c - a;
	norm = cross( edge1, edge2 );

	float det = - dot( rayDirection, norm );
	float invdet = 1.0 / det;

	vec3 AO = rayOrigin - a;
	vec3 DAO = cross( AO, rayDirection );

	vec4 uvt;
	uvt.x = dot( edge2, DAO ) * invdet;
	uvt.y = - dot( edge1, DAO ) * invdet;
	uvt.z = dot( AO, norm ) * invdet;
	uvt.w = 1.0 - uvt.x - uvt.y;

	// set the hit information
	barycoord = uvt.wxy; // arranged in A, B, C order
	dist = uvt.z;
	side = sign( det );
	norm = side * normalize( norm );

	// add an epsilon to avoid misses between triangles
	uvt += vec4( TRI_INTERSECT_EPSILON );

	return all( greaterThanEqual( uvt, vec4( 0.0 ) ) );

}

bool intersectTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// outputs
	inout float minDistance, inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	bool found = false;
	vec3 localBarycoord, localNormal;
	float localDist, localSide;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		if (
			intersectsTriangle( rayOrigin, rayDirection, a, b, c, localBarycoord, localNormal, localDist, localSide )
			&& localDist < minDistance
		) {

			found = true;
			minDistance = localDist;

			faceIndices = uvec4( indices.xyz, i );
			faceNormal = localNormal;

			side = localSide;
			barycoord = localBarycoord;
			dist = localDist;

		}

	}

	return found;

}

bool intersectsBVHNodeBounds( vec3 rayOrigin, vec3 rayDirection, sampler2D bvhBounds, uint currNodeIndex, out float dist ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return intersectsBounds( rayOrigin, rayDirection, boundsMin, boundsMax, dist );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define	bvhIntersectFirstHit(		bvh,		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist	)	_bvhIntersectFirstHit(		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist	)

bool _bvhIntersectFirstHit(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// output variables split into separate variables due to output precision
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int pointer = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float triangleDistance = INFINITY;
	bool found = false;
	while ( pointer > - 1 && pointer < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ pointer ];
		pointer --;

		// check if we intersect the current bounds
		float boundsHitDistance;
		if (
			! intersectsBVHNodeBounds( rayOrigin, rayDirection, bvh_bvhBounds, currNodeIndex, boundsHitDistance )
			|| boundsHitDistance > triangleDistance
		) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );

		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;

			found = intersectTriangles(
				bvh_position, bvh_index, offset, count,
				rayOrigin, rayDirection, triangleDistance,
				faceIndices, faceNormal, barycoord, side, dist
			) || found;

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = currNodeIndex + boundsInfo.y;

			bool leftToRight = rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			pointer ++;
			stack[ pointer ] = c2;

			pointer ++;
			stack[ pointer ] = c1;

		}

	}

	return found;

}
`,ue=`
struct BVH {

	usampler2D index;
	sampler2D position;

	sampler2D bvhBounds;
	usampler2D bvhContents;

};
`,wn=Object.freeze(Object.defineProperty({__proto__:null,bvh_distance_functions:ce,bvh_ray_functions:le,bvh_struct_definitions:ue,common_functions:ae},Symbol.toStringTag,{value:"Module"})),Bn=ue,An=ce,_n=`
	${ae}
	${le}
`;export{Tn as AVERAGE,fe as BVH,wt as BVHHelper,wn as BVHShaderGLSL,Dn as CENTER,Pn as CONTAINED,pe as ExtendedTriangle,tn as FloatVertexAttributeTexture,bt as GeometryBVH,$ as INTERSECTED,gn as IntVertexAttributeTexture,un as LineBVH,Re as LineLoopBVH,Oe as LineSegmentsBVH,be as MeshBVH,pn as MeshBVHHelper,bn as MeshBVHUniformStruct,O as NOT_INTERSECTED,fn as ObjectBVH,En as OrientedBox,dn as PointsBVH,Nn as SAH,At as SKIP_GENERATION,hn as SkinnedMeshBVH,In as StaticGeometryGenerator,Qe as UIntVertexAttributeTexture,Bt as VertexAttributeTexture,Hn as acceleratedRaycast,Fn as computeBatchedBoundsTree,Vn as computeBoundsTree,zn as disposeBatchedBoundsTree,kn as disposeBoundsTree,xn as estimateMemoryInBytes,Cn as generateIndirectBuffer,mn as getBVHExtremes,vn as getJSONStructure,On as getTriangleHitPointInfo,An as shaderDistanceFunction,_n as shaderIntersectFunction,Bn as shaderStructs,yn as validateBounds};
