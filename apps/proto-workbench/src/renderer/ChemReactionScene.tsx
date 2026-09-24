import { Camera, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChemMolecule, ChemSimulationResult } from '../shared/chem-science.ts';
import { CHEM_SERIES_COLORS } from './chem-reaction-view.ts';
import {surfaceSiteOccupants,type ChemSurfaceCoverage} from './chem-interface-view.ts';

type V3 = [number,number,number];
type Mesh = { positions:number[]; normals:number[]; colors:number[] };
export interface ChemTrajectoryView { kind:'provided-xyz-trajectory'; frames:{index:number;time_fs:number;comment:string;atoms:{element:string;x:number;y:number;z:number}[]}[]; atom_count:number; frame_count:number; frame_interval_fs:number; source_sha256:string }
const elementColors:Record<string,string>={H:'#d9d8d2',C:'#777977',N:'#618bc4',O:'#c57472',S:'#c6b267',P:'#c09567',F:'#7fa286',Cl:'#7fa286',Br:'#aa8280',I:'#9d86b5',Cu:'#bc987a',Fe:'#aa8b7b'};
const rgb=(hex:string):V3=>[parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255];
const unit=(v:V3):V3=>{const d=Math.hypot(...v)||1;return [v[0]/d,v[1]/d,v[2]/d];};
function vertex(mesh:Mesh,p:V3,n:V3,color:V3){mesh.positions.push(...p);mesh.normals.push(...n);mesh.colors.push(...color);}
function sphere(mesh:Mesh,center:V3,radius:number,color:V3){
  const point=(lat:number,lon:number):V3=>[Math.sin(lat)*Math.cos(lon),Math.cos(lat),Math.sin(lat)*Math.sin(lon)];
  for(let y=0;y<6;y++)for(let x=0;x<8;x++){
    const ns=[point(y*Math.PI/6,x*Math.PI/4),point((y+1)*Math.PI/6,x*Math.PI/4),point((y+1)*Math.PI/6,(x+1)*Math.PI/4),point(y*Math.PI/6,(x+1)*Math.PI/4)];
    for(const i of [0,1,2,0,2,3]){const n=ns[i];vertex(mesh,[center[0]+n[0]*radius,center[1]+n[1]*radius,center[2]+n[2]*radius],n,color);}
  }
}
function bond(mesh:Mesh,a:V3,b:V3,color:V3,radius=0.055){
  const axis=unit([b[0]-a[0],b[1]-a[1],b[2]-a[2]]);const ref:V3=Math.abs(axis[1])>.9?[1,0,0]:[0,1,0];
  const u=unit([axis[1]*ref[2]-axis[2]*ref[1],axis[2]*ref[0]-axis[0]*ref[2],axis[0]*ref[1]-axis[1]*ref[0]]);
  const v:V3=[axis[1]*u[2]-axis[2]*u[1],axis[2]*u[0]-axis[0]*u[2],axis[0]*u[1]-axis[1]*u[0]];
  for(let i=0;i<6;i++){
    const normal=(t:number):V3=>[u[0]*Math.cos(t)+v[0]*Math.sin(t),u[1]*Math.cos(t)+v[1]*Math.sin(t),u[2]*Math.cos(t)+v[2]*Math.sin(t)];
    const n1=normal(i*Math.PI/3),n2=normal((i+1)*Math.PI/3);
    const p=(center:V3,n:V3):V3=>[center[0]+radius*n[0],center[1]+radius*n[1],center[2]+radius*n[2]];
    for(const [center,n] of [[a,n1],[b,n1],[b,n2],[a,n1],[b,n2],[a,n2]] as [V3,V3][])vertex(mesh,p(center,n),n,color);
  }
}
function addMolecule(mesh:Mesh,molecule:ChemMolecule|undefined,center:V3,tint:string,hydrogens:boolean,angle:number){
  if(!molecule?.atoms.length){sphere(mesh,center,.19,rgb(tint));return;}
  const atoms=molecule.atoms,mean:V3=[0,0,0];for(const atom of atoms){mean[0]+=atom.x/atoms.length;mean[1]+=atom.y/atoms.length;mean[2]+=atom.z/atoms.length;}
  const maxRadius=Math.max(1.5,...atoms.map(a=>Math.hypot(a.x-mean[0],a.y-mean[1],a.z-mean[2])));
  const scale=.55/maxRadius;
  const points:V3[]=atoms.map(a=>{const x=(a.x-mean[0])*scale,y=(a.y-mean[1])*scale,z=(a.z-mean[2])*scale;return [center[0]+x*Math.cos(angle)-z*Math.sin(angle),center[1]+y,center[2]+x*Math.sin(angle)+z*Math.cos(angle)];});
  for(let i=0;i<atoms.length;i++)if(hydrogens||atoms[i].element!=='H')sphere(mesh,points[i],atoms[i].element==='H'?.073:.12,rgb(elementColors[atoms[i].element]||tint));
  for(const link of molecule.bonds){if(!points[link.start]||!points[link.end])continue;if(!hydrogens&&(atoms[link.start].element==='H'||atoms[link.end].element==='H'))continue;bond(mesh,points[link.start],points[link.end],rgb('#999991'),.047);}
}
export type ChemPopulationScene=Pick<ChemSimulationResult,'series'|'scene'>;
function reactionMesh(result:ChemPopulationScene,index:number,hydrogens:boolean):Mesh{
  const mesh:Mesh={positions:[],normals:[],colors:[]};
  const maxTotal=Math.max(Number.EPSILON,...result.scene.frames.map(f=>Object.values(f.populations).reduce((s,v)=>s+v,0)));
  const frame=result.scene.frames[index];
  for(let speciesIndex=0;speciesIndex<result.series.length;speciesIndex++){
    const species=result.series[speciesIndex],count=Math.min(60,Math.round((frame?.populations[species.id]||0)*48/maxTotal));
    for(let i=0;i<count;i++){
      // Fixed, deterministic display positions; these are never reported as a trajectory.
      const slot=speciesIndex*137+i+1,phase=slot*2.399963229728653;
      const y=((slot*.61803398875)%1-.5)*5.4,radius=1.3+((slot*.754877666)%1)*2.4;
      addMolecule(mesh,species.molecule,[Math.cos(phase)*radius,y,Math.sin(phase)*radius],CHEM_SERIES_COLORS[speciesIndex%CHEM_SERIES_COLORS.length],hydrogens,phase);
    }
  }
  return mesh;
}
const vertexSource=`attribute vec3 a_position;attribute vec3 a_normal;attribute vec3 a_color;uniform vec2 u_angles;uniform float u_aspect;uniform float u_distance;varying vec3 v_color;varying vec3 v_normal;
vec3 rotate(vec3 p){float cy=cos(u_angles.x),sy=sin(u_angles.x),cx=cos(u_angles.y),sx=sin(u_angles.y);vec3 q=vec3(cy*p.x+sy*p.z,p.y,-sy*p.x+cy*p.z);return vec3(q.x,cx*q.y-sx*q.z,sx*q.y+cx*q.z);}
void main(){vec3 p=rotate(a_position);p.z-=u_distance;gl_Position=vec4(p.x*2.2/u_aspect,p.y*2.2,-1.002*p.z-0.2002,-p.z);v_color=a_color;v_normal=rotate(a_normal);}`;
const fragmentSource=`precision mediump float;varying vec3 v_color;varying vec3 v_normal;void main(){vec3 n=normalize(v_normal);float d=max(0.,dot(n,normalize(vec3(-.5,.8,1.))));float spec=pow(max(0.,dot(n,normalize(vec3(-.25,.4,1.)))),24.)*.16;gl_FragColor=vec4(v_color*(.42+.58*d)+spec,1.);}`;

function surfaceMesh(surface:ChemSurfaceCoverage,index:number):Mesh{
  const mesh:Mesh={positions:[],normals:[],colors:[]};
  const occupants=surfaceSiteOccupants(surface,index);
  for(let row=0;row<10;row++)for(let col=0;col<10;col++){
    const point:V3=[(col-4.5)*.62,-1,(row-4.5)*.62];
    sphere(mesh,point,.1,rgb('#999991'));
    if(col<9)bond(mesh,point,[point[0]+.62,-1,point[2]],rgb('#999991'),.022);
    if(row<9)bond(mesh,point,[point[0],-1,point[2]+.62],rgb('#999991'),.022);
    const species=occupants[row*10+col];
    if(species>=0){bond(mesh,point,[point[0],-.66,point[2]],rgb('#999991'),.035);sphere(mesh,[point[0],-.48,point[2]],.18,rgb(CHEM_SERIES_COLORS[species%CHEM_SERIES_COLORS.length]));}
  }
  return mesh;
}

/** A population scene driven by ODE samples. It deliberately never interpolates a reaction path. */
export function ChemReactionScene({result,index,active=true,molecule,trajectory,surface}: {result?:ChemPopulationScene;index:number;active?:boolean;molecule?:ChemMolecule;trajectory?:ChemTrajectoryView;surface?:ChemSurfaceCoverage}){
  const canvas=useRef<HTMLCanvasElement>(null),draw=useRef<(()=>void)|undefined>(undefined),camera=useRef({yaw:.4,pitch:surface?.kind==='surface-coverage'?.65:-.15,distance:11});
  const [error,setError]=useState(''),[hydrogens,setHydrogens]=useState(!!molecule||!!trajectory);
  useEffect(()=>{
    const element=canvas.current;if(!element||!active)return;
    const gl=element.getContext('webgl',{antialias:true,alpha:true,preserveDrawingBuffer:true});
    if(!gl){setError('WebGL is unavailable. The concentration data and charts remain available below.');return;}
    let program:WebGLProgram|null=null;const buffers:WebGLBuffer[]=[];const shaders:WebGLShader[]=[];
    try{
      const shader=(type:number,source:string)=>{const s=gl.createShader(type);if(!s)throw new Error('Cannot allocate WebGL shader.');shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('The 3D shader could not compile.');return s;};
      program=gl.createProgram();if(!program)throw new Error('Cannot allocate WebGL program.');gl.attachShader(program,shader(gl.VERTEX_SHADER,vertexSource));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragmentSource));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('The 3D scene could not initialize.');
      gl.useProgram(program);gl.enable(gl.DEPTH_TEST);setError('');
      const mesh:Mesh={positions:[],normals:[],colors:[]};
      const geometry=surface?surfaceMesh(surface,index):result?reactionMesh(result,index,hydrogens):mesh;
      if(molecule){addMolecule(geometry,molecule,[0,0,0],CHEM_SERIES_COLORS[0],hydrogens,0);for(let i=0;i<geometry.positions.length;i++)geometry.positions[i]*=5;}
      if(trajectory?.frames.length){
        const min:V3=[Infinity,Infinity,Infinity],max:V3=[-Infinity,-Infinity,-Infinity];
        for(const frame of trajectory.frames)for(const atom of frame.atoms)for(const [dimension,coordinate] of [atom.x,atom.y,atom.z].entries()){min[dimension]=Math.min(min[dimension],coordinate);max[dimension]=Math.max(max[dimension],coordinate);}
        const center:V3=[(min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2];const scale=5/Math.max(2,max[0]-min[0],max[1]-min[1],max[2]-min[2]);
        // One frame-independent camera transform preserves the supplied movement and distances.
        for(const atom of trajectory.frames[index]?.atoms||[])if(hydrogens||atom.element!=='H')sphere(geometry,[(atom.x-center[0])*scale,(atom.y-center[1])*scale,(atom.z-center[2])*scale],atom.element==='H'?.14:.23,rgb(elementColors[atom.element]||'#94978f'));
      }
      for(const [name,values] of [['a_position',geometry.positions],['a_normal',geometry.normals],['a_color',geometry.colors]] as const){const buffer=gl.createBuffer();if(!buffer)throw new Error('Cannot allocate 3D geometry.');buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);const location=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);}
      const angles=gl.getUniformLocation(program,'u_angles'),aspect=gl.getUniformLocation(program,'u_aspect'),distance=gl.getUniformLocation(program,'u_distance');
      draw.current=()=>{const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)return;const density=Math.min(2,window.devicePixelRatio||1);element.width=Math.round(rect.width*density);element.height=Math.round(rect.height*density);gl.viewport(0,0,element.width,element.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.uniform2f(angles,camera.current.yaw,camera.current.pitch);gl.uniform1f(aspect,element.width/element.height);gl.uniform1f(distance,camera.current.distance);gl.drawArrays(gl.TRIANGLES,0,geometry.positions.length/3);};
      const observer=new ResizeObserver(()=>draw.current?.());observer.observe(element);draw.current();
      const wheel=(event:WheelEvent)=>{event.preventDefault();camera.current.distance=Math.max(4,Math.min(25,camera.current.distance+event.deltaY*.01));draw.current?.();};element.addEventListener('wheel',wheel,{passive:false});
      const lost=(event:Event)=>{event.preventDefault();setError('The graphics context was interrupted. Reopen the scene to restore the view.');};element.addEventListener('webglcontextlost',lost);
      return()=>{observer.disconnect();element.removeEventListener('wheel',wheel);element.removeEventListener('webglcontextlost',lost);draw.current=undefined;for(const buffer of buffers)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);for(const s of shaders)gl.deleteShader(s);};
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));for(const buffer of buffers)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);for(const s of shaders)gl.deleteShader(s);}
  },[result,index,hydrogens,active,molecule,trajectory,surface]);
  const drag=useRef<{x:number;y:number}|undefined>(undefined);
  return <div className="chem-reaction-scene">
    <div className="chem-scene-toolbar"><span>{surface?'3D surface occupancy':trajectory?'Provided XYZ coordinates':molecule?'Molecular geometry':'3D population view'}</span>{!surface&&<label><input type="checkbox" checked={hydrogens} onChange={e=>setHydrogens(e.target.checked)}/>Hydrogens</label>}<button type="button" title="Reset camera" aria-label="Reset reaction camera" onClick={()=>{camera.current={yaw:.4,pitch:surface?.kind==='surface-coverage'?.65:-.15,distance:11};draw.current?.();}}><RotateCcw size={14}/></button><button type="button" title="Export current 3D view as PNG" aria-label="Export reaction scene PNG" onClick={()=>canvas.current?.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=surface?'chem-surface-occupancy.png':trajectory?'chem-xyz-frame.png':molecule?'chem-molecule.png':'chem-reaction-population.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})}><Camera size={14}/></button></div>
    <canvas ref={canvas} aria-label={surface?'Interactive three-dimensional surface occupancy schematic':trajectory?'Interactive provided XYZ atomic coordinates':molecule?'Interactive ball-and-stick molecular geometry':'Interactive three-dimensional population representation of computed concentrations'} tabIndex={0} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();if(event.key==='ArrowLeft')camera.current.yaw-=.1;if(event.key==='ArrowRight')camera.current.yaw+=.1;if(event.key==='ArrowUp')camera.current.pitch-=.1;if(event.key==='ArrowDown')camera.current.pitch+=.1;if(event.key==='+')camera.current.distance=Math.max(4,camera.current.distance-1);if(event.key==='-')camera.current.distance=Math.min(25,camera.current.distance+1);draw.current?.();}} onPointerDown={event=>{drag.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!drag.current)return;camera.current.yaw+=(event.clientX-drag.current.x)*.008;camera.current.pitch+=(event.clientY-drag.current.y)*.008;drag.current={x:event.clientX,y:event.clientY};draw.current?.();}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}/>
    {error&&<div className="chem-scene-error" role="status">{error}</div>}
    {!result&&!molecule&&!trajectory&&!surface&&<div className="chem-scene-empty"><h3>Your reaction, in view.</h3><p>Run a model to connect its calculated concentrations with a three-dimensional population scene.</p></div>}
    <div className="chem-scene-caption">{surface?surface.description:trajectory?'Supplied coordinates, preserved across frames. XYZ contains no bond topology; physical validity is not inferred.':molecule?`${molecule.geometry_method} · ${molecule.geometry_status}`:'Spatial arrangement is illustrative; molecule counts follow computed samples. This is not an atomistic reaction trajectory.'}<span>Drag to rotate · Scroll to zoom · Arrow keys supported</span></div>
  </div>;
}
