/* ═══════════ CURSOR ═══════════ */
const cur=document.getElementById('cur'),ring=document.getElementById('ring');
let mx=innerWidth/2,my=innerHeight/2,tx=mx,ty=my;
document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;cur.style.cssText+=`left:${mx}px;top:${my}px`});
(function lc(){tx+=(mx-tx)*.09;ty+=(my-ty)*.09;ring.style.cssText=`left:${tx}px;top:${ty}px`;requestAnimationFrame(lc)})();

/* ═══════════ NAV ═══════════ */
const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>nav.classList.toggle('s',scrollY>60));
const ham=document.getElementById('ham'),mm=document.getElementById('mm'),mc=document.getElementById('mc');
ham.onclick=()=>mm.classList.add('open');
mc.onclick=()=>mm.classList.remove('open');
document.querySelectorAll('.mml').forEach(l=>l.addEventListener('click',()=>mm.classList.remove('open')));

/* ═══════════ BG CANVAS ═══════════ */
(()=>{
  const c=document.getElementById('bg'),ctx=c.getContext('2d');
  let W,H;
  const rs=()=>{W=c.width=innerWidth;H=c.height=innerHeight};
  rs();window.addEventListener('resize',rs);
  const pts=Array.from({length:80},()=>({x:Math.random(),y:Math.random(),vx:(Math.random()-.5)*.00022,vy:(Math.random()-.5)*.00022,r:Math.random()*1.5+.4,a:Math.random()*.22+.04}));
  let fmx=.5,fmy=.5;
  document.addEventListener('mousemove',e=>{fmx=e.clientX/innerWidth;fmy=e.clientY/innerHeight});
  function fr(){
    ctx.clearRect(0,0,W,H);
    const g=ctx.createRadialGradient(W*.4+fmx*W*.1,H*.3+fmy*H*.1,0,W*.5,H*.5,W*.85);
    g.addColorStop(0,'#0c0a04');g.addColorStop(.5,'#080808');g.addColorStop(1,'#040404');
    ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    for(let i=0;i<pts.length;i++){for(let j=i+1;j<pts.length;j++){const dx=(pts[i].x-pts[j].x)*W,dy=(pts[i].y-pts[j].y)*H,d=Math.sqrt(dx*dx+dy*dy);if(d<140){ctx.beginPath();ctx.moveTo(pts[i].x*W,pts[i].y*H);ctx.lineTo(pts[j].x*W,pts[j].y*H);ctx.strokeStyle=`rgba(200,169,81,${.04*(1-d/140)})`;ctx.lineWidth=.4;ctx.stroke()}}}
    pts.forEach(p=>{ctx.beginPath();ctx.arc(p.x*W,p.y*H,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(200,169,81,${p.a})`;ctx.fill();p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=1;if(p.x>1)p.x=0;if(p.y<0)p.y=1;if(p.y>1)p.y=0});
    requestAnimationFrame(fr);
  }
  fr();
})();

/* ═══════════ ORB (Three.js) ═══════════ */
(()=>{
  const canvas=document.getElementById('orb');
  if(!canvas)return;
  function sz(){return Math.min(500,Math.min(canvas.parentElement.clientWidth*.85,canvas.parentElement.clientHeight))}
  const s=sz();canvas.width=s;canvas.height=s;
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(s,s);
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(42,1,.1,100);camera.position.z=5.5;
  const geo=new THREE.IcosahedronGeometry(1.8,5);
  const mat=new THREE.MeshPhongMaterial({color:0x1a1200,emissive:0x0c0800,shininess:130,specular:0xc8a951,transparent:true,opacity:.88});
  const orb=new THREE.Mesh(geo,mat);scene.add(orb);
  scene.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.86,2),new THREE.MeshBasicMaterial({color:0xc8a951,wireframe:true,transparent:true,opacity:.07})));
  const core=new THREE.Mesh(new THREE.SphereGeometry(1.05,32,32),new THREE.MeshBasicMaterial({color:0xc8732a,transparent:true,opacity:.11}));scene.add(core);
  [[2.4,.012,0xc8a951,.18,Math.PI/2,.003],[2.9,.007,0xe2c97e,.1,Math.PI/2.5,-.002],[3.3,.005,0xf5e6b8,.06,Math.PI/3,.0015]].forEach(([r,t,col,op,rx,spd])=>{const rg=new THREE.Mesh(new THREE.TorusGeometry(r,t,16,200),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:op}));rg.rotation.x=rx;rg.userData.spd=spd;scene.add(rg)});
  const dg=new THREE.BufferGeometry();const dp=new Float32Array(600);for(let i=0;i<200;i++){const phi=Math.acos(-1+2*Math.random()),th=2*Math.PI*Math.random(),r=3+Math.random()*2;dp[i*3]=r*Math.sin(phi)*Math.cos(th);dp[i*3+1]=r*Math.sin(phi)*Math.sin(th);dp[i*3+2]=r*Math.cos(phi)}dg.setAttribute('position',new THREE.BufferAttribute(dp,3));scene.add(new THREE.Points(dg,new THREE.PointsMaterial({color:0xc8a951,size:.04,transparent:true,opacity:.45})));
  scene.add(new THREE.AmbientLight(0x1a1000,3));const l1=new THREE.DirectionalLight(0xc8a951,5);l1.position.set(3,3,3);scene.add(l1);const l2=new THREE.DirectionalLight(0xc8732a,2);l2.position.set(-4,-2,2);scene.add(l2);const pl=new THREE.PointLight(0xe2c97e,4,10);pl.position.set(0,0,3);scene.add(pl);
  let omx=0,omy=0;document.addEventListener('mousemove',e=>{omx=(e.clientX/innerWidth-.5)*2;omy=-(e.clientY/innerHeight-.5)*2});
  window.addEventListener('resize',()=>{const ns=sz();canvas.width=ns;canvas.height=ns;renderer.setSize(ns,ns)});
  let t=0;(function a(){requestAnimationFrame(a);t+=.007;const b=1+Math.sin(t*.6)*.038;orb.scale.set(b,b,b);core.scale.set(1+Math.sin(t*1.2)*.07,1+Math.sin(t*1.2)*.07,1+Math.sin(t*1.2)*.07);orb.rotation.y=t*.15+omx*.25;orb.rotation.x=omy*.18;scene.children.forEach(c=>{if(c.userData.spd)c.rotation.y+=c.userData.spd});renderer.render(scene,camera)})();
})();

/* ═══════════ DNA HELIX ═══════════ */
(()=>{
  const c=document.getElementById('dna');if(!c)return;
  const ctx=c.getContext('2d'),W=340,H=460,cx=W/2;let t=0;
  (function d(){requestAnimationFrame(d);ctx.clearRect(0,0,W,H);t+=.65;const step=H/13;
  for(let i=-1;i<15;i++){const y=i*step+(t%step),wave=Math.sin(i*.72+t*.04)*52,x1=cx-wave,x2=cx+wave,alpha=.12+Math.abs(Math.sin(i*.5+t*.03))*.42;
    ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.strokeStyle=`rgba(200,169,81,${alpha*.38})`;ctx.lineWidth=.9;ctx.stroke();
    [x1,x2].forEach((x,idx)=>{ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);const g=ctx.createRadialGradient(x,y,0,x,y,5);g.addColorStop(0,`rgba(${idx?'200,115,42':'226,201,126'},${alpha})`);g.addColorStop(1,'rgba(200,169,81,0)');ctx.fillStyle=g;ctx.fill()});
  }
  ctx.beginPath();for(let y=0;y<=H;y+=2)ctx.lineTo(cx-Math.sin((y+t)*.065)*52,y);ctx.strokeStyle='rgba(200,169,81,.28)';ctx.lineWidth=1.6;ctx.stroke();
  ctx.beginPath();for(let y=0;y<=H;y+=2)ctx.lineTo(cx+Math.sin((y+t)*.065)*52,y);ctx.strokeStyle='rgba(200,115,42,.28)';ctx.lineWidth=1.6;ctx.stroke();
  })();
})();

/* ═══════════ PILLAR ICONS ═══════════ */
const iconTypes=['gut','breath','fast','sleep','ayur','trauma'];
iconTypes.forEach((tp,i)=>{
  const c=document.getElementById(`ic${i+1}`);if(!c)return;
  const ctx=c.getContext('2d'),S=48,cx=24,cy=24;let t=0;
  (function d(){requestAnimationFrame(d);t+=.025;ctx.clearRect(0,0,S,S);
    if(tp==='gut'){for(let j=0;j<3;j++){ctx.beginPath();ctx.arc(cx+Math.sin(t+j*2)*6,cy+Math.cos(t*.8+j*2)*5,5+j*2,0,Math.PI*2);ctx.strokeStyle=`rgba(200,169,81,${.3+j*.15})`;ctx.lineWidth=1;ctx.stroke()}}
    else if(tp==='breath'){for(let j=0;j<20;j++){const a=j/20*Math.PI*2+t*.3,r=14+Math.sin(t*2+j)*4;ctx.beginPath();ctx.arc(cx+r*Math.cos(a),cy+r*Math.sin(a),.9,0,Math.PI*2);ctx.fillStyle=`rgba(200,169,81,${.2+Math.sin(t+j)*.15})`;ctx.fill()}}
    else if(tp==='fast'){ctx.beginPath();ctx.arc(cx,cy,14,0,Math.PI*2);ctx.strokeStyle='rgba(200,169,81,.25)';ctx.lineWidth=1;ctx.stroke();const progress=(Math.sin(t*.4)+1)/2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,14,-Math.PI/2,-Math.PI/2+progress*Math.PI*2);ctx.closePath();ctx.fillStyle='rgba(200,169,81,.18)';ctx.fill();ctx.beginPath();ctx.arc(cx,cy,4+Math.sin(t)*1,0,Math.PI*2);ctx.fillStyle='rgba(226,201,126,.7)';ctx.fill()}
    else if(tp==='sleep'){for(let j=0;j<5;j++){const y=cy-8+j*4,w=20-Math.abs(j-2)*4,alpha=.15+Math.abs(Math.sin(t+j*.5))*.3;ctx.beginPath();ctx.moveTo(cx-w,y);for(let x=cx-w;x<=cx+w;x++){ctx.lineTo(x,y+Math.sin((x+t*20)*0.3)*2)}ctx.strokeStyle=`rgba(200,169,81,${alpha})`;ctx.lineWidth=.9;ctx.stroke()}}
    else if(tp==='ayur'){const pts2=6;for(let j=0;j<pts2;j++){const a=j/pts2*Math.PI*2+t*.1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx+12*Math.cos(a),cy+12*Math.sin(a),5,0,Math.PI*2);ctx.fillStyle=`rgba(200,169,81,${.08+Math.abs(Math.sin(t+j))*.1})`;ctx.fill()}ctx.beginPath();ctx.arc(cx,cy,6+Math.sin(t)*.8,0,Math.PI*2);const g=ctx.createRadialGradient(cx,cy,0,cx,cy,7);g.addColorStop(0,'rgba(226,201,126,.8)');g.addColorStop(1,'rgba(200,169,81,0)');ctx.fillStyle=g;ctx.fill()}
    else{ctx.save();ctx.translate(cx,cy);for(let j=0;j<8;j++){const a=j/8*Math.PI*2+t*.12,r=14+Math.sin(t*2+j)*2.5;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(r*Math.cos(a),r*Math.sin(a));ctx.strokeStyle=`rgba(200,169,81,${.12+Math.sin(t+j)*.08})`;ctx.lineWidth=1;ctx.stroke()}ctx.beginPath();ctx.arc(0,0,5+Math.sin(t)*1.2,0,Math.PI*2);const g=ctx.createRadialGradient(0,0,0,0,0,6);g.addColorStop(0,'rgba(200,115,42,.8)');g.addColorStop(1,'rgba(200,169,81,0)');ctx.fillStyle=g;ctx.fill();ctx.restore()}
  })();
});

/* ═══════════ PROTOCOL TABS ═══════════ */
document.querySelectorAll('.ptab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.ptab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.ppanel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`p${btn.dataset.tab}`).classList.add('active');
  });
});

/* ═══════════ PROTOCOL VISUALS ═══════════ */
[['pvc0','sun'],['pvc1','helix'],['pvc2','wave'],['pvc3','spiral']].forEach(([id,tp])=>{
  const c=document.getElementById(id);if(!c)return;
  const ctx=c.getContext('2d'),W=360,H=360,cx=W/2,cy=H/2;let t=0;
  (function d(){
    requestAnimationFrame(d);t+=.012;ctx.clearRect(0,0,W,H);
    if(tp==='sun'){for(let r=120;r>10;r-=18){const prog=(120-r)/120;ctx.beginPath();ctx.arc(cx,cy,r+Math.sin(t*2+r*.05)*4,0,Math.PI*2);ctx.strokeStyle=`rgba(200,169,81,${.04+prog*.08})`;ctx.lineWidth=.8;ctx.stroke()}for(let i=0;i<24;i++){const a=i/24*Math.PI*2+t*.05,r1=50,r2=90+Math.sin(t*3+i)*12;ctx.beginPath();ctx.moveTo(cx+r1*Math.cos(a),cy+r1*Math.sin(a));ctx.lineTo(cx+r2*Math.cos(a),cy+r2*Math.sin(a));ctx.strokeStyle='rgba(200,169,81,.15)';ctx.lineWidth=1;ctx.stroke()}ctx.beginPath();ctx.arc(cx,cy,40+Math.sin(t)*.02*40,0,Math.PI*2);const sg=ctx.createRadialGradient(cx,cy,0,cx,cy,45);sg.addColorStop(0,'rgba(226,201,126,.5)');sg.addColorStop(1,'rgba(200,169,81,0)');ctx.fillStyle=sg;ctx.fill()}
    else if(tp==='helix'){for(let y=20;y<H-20;y+=3){const wave=Math.sin((y+t*40)*.055)*80,alpha=.1+Math.abs(Math.sin((y+t*20)*.04))*.3;ctx.beginPath();ctx.arc(cx+wave,y,3,0,Math.PI*2);ctx.fillStyle=`rgba(200,169,81,${alpha})`;ctx.fill();ctx.beginPath();ctx.arc(cx-wave,y,3,0,Math.PI*2);ctx.fillStyle=`rgba(200,115,42,${alpha})`;ctx.fill();if(y%18<3){ctx.beginPath();ctx.moveTo(cx+wave,y);ctx.lineTo(cx-wave,y);ctx.strokeStyle=`rgba(200,169,81,${alpha*.5})`;ctx.lineWidth=.8;ctx.stroke()}}}
    else if(tp==='wave'){for(let i=0;i<6;i++){ctx.beginPath();for(let x=0;x<W;x++){const y=cy+(Math.sin(x*.04+t+i*.6)*40+Math.sin(x*.08-t*.5+i)*20)/(1+i*.3);x===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}ctx.strokeStyle=`rgba(200,169,81,${.15-i*.02})`;ctx.lineWidth=1.2-i*.15;ctx.stroke()}}
    else{ctx.beginPath();for(let i=0;i<500;i++){const a=i*.12+t,r=i*.28;if(r>160)break;ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a))}ctx.strokeStyle='rgba(200,169,81,.35)';ctx.lineWidth=1;ctx.stroke();ctx.beginPath();ctx.arc(cx,cy,10+Math.sin(t*2)*3,0,Math.PI*2);const g=ctx.createRadialGradient(cx,cy,0,cx,cy,14);g.addColorStop(0,'rgba(226,201,126,.7)');g.addColorStop(1,'rgba(200,169,81,0)');ctx.fillStyle=g;ctx.fill()}
  })();
});

/* ═══════════ INSIGHT CARD CANVASES ═══════════ */
[['icard1','gut'],['icard2','breath'],['icard3','ayur2']].forEach(([id,tp])=>{
  const c=document.getElementById(id);if(!c)return;
  const ctx=c.getContext('2d');let t=0;
  function rs(){c.width=c.offsetWidth||400;c.height=c.offsetHeight||240}rs();window.addEventListener('resize',rs);
  (function d(){
    requestAnimationFrame(d);t+=.008;
    const W=c.width,H=c.height,cx=W/2,cy=H/2;
    ctx.clearRect(0,0,W,H);
    const bg=ctx.createRadialGradient(cx,cy,0,cx,cy,W*.6);
    if(tp==='gut'){bg.addColorStop(0,'#0f0c03');bg.addColorStop(1,'#070707')}
    else if(tp==='breath'){bg.addColorStop(0,'#030a0f');bg.addColorStop(1,'#070707')}
    else{bg.addColorStop(0,'#0a0803');bg.addColorStop(1,'#070707')}
    ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
    if(tp==='gut'){for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(cx+Math.sin(t+i)*20,cy+Math.cos(t*.7+i)*15,30+i*15,0,Math.PI*2);ctx.strokeStyle=`rgba(200,169,81,${.08-i*.015})`;ctx.lineWidth=1;ctx.stroke()}}
    else if(tp==='breath'){for(let i=0;i<30;i++){const a=i/30*Math.PI*2+t*.4,r=40+Math.sin(t*2+i)*20;ctx.beginPath();ctx.arc(cx+r*Math.cos(a),cy+r*Math.sin(a),2,0,Math.PI*2);ctx.fillStyle=`rgba(200,169,81,${.2+Math.sin(t+i)*.1})`;ctx.fill()}}
    else{for(let i=0;i<8;i++){const a=i/8*Math.PI*2+t*.08,r=40+Math.sin(t+i)*10;ctx.beginPath();ctx.arc(cx+r*Math.cos(a),cy+r*Math.sin(a),4,0,Math.PI*2);ctx.fillStyle=`rgba(200,150,42,${.2+Math.sin(t+i)*.1})`;ctx.fill()}}
  })();
});

/* ═══════════ SCROLL REVEAL ═══════════ */
const obs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)e.target.classList.add('in')}),{threshold:.1});
document.querySelectorAll('.rv').forEach(el=>obs.observe(el));
