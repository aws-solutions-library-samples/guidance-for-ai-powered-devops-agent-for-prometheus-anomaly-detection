/*
 * Self-contained SVG of the 5G RCF Guidance architecture, mirroring the layout of
 * generate-guidance-pptx.cjs (same coordinates, in inches x 96 = px). Official AWS
 * icons are embedded as base64 so the SVG renders standalone and converts cleanly
 * with rsvg-convert. Produces docs/diagrams/5g-rcf-architecture-guidance.svg; a PNG
 * for the README is made with:  rsvg-convert -w 2560 <svg> -o <png>
 *
 * Run: node docs/diagrams/generate-guidance-svg.cjs <out.svg>
 */
const fs = require('fs'), path = require('path');
const out = process.argv[2] || path.join(__dirname, '5g-rcf-architecture-guidance.svg');
const IN = 96;                                  // px per inch
const W = 13.33 * IN, H = 7.5 * IN;
const DARK='#232F3E', TEAL='#00A4A6', ORANGE='#FF9900', GREEN='#1B8B1B', PURPLE='#7C3AED',
      RED='#D13212', GRAY='#545B64', WHITE='#FFFFFF', GREENBG='#DCEEDC', SIDEBAR='#EAEDED';
const FF = 'Arial, Helvetica, sans-serif';
const x = i => +(i*IN).toFixed(1);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const b64 = f => fs.readFileSync(path.join(__dirname,'icons',f+'.png')).toString('base64');
const S = [];

// ── background + arrow markers ──
S.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${WHITE}"/>`);
const marker = (id,c) => `<marker id="${id}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,3 L0,6" fill="none" stroke="${c}" stroke-width="1.4"/></marker>`;
S.push(`<defs>${marker('aG',GREEN)}${marker('aGray',GRAY)}${marker('aP',PURPLE)}${marker('aR',RED)}</defs>`);

// ── title + description + separator ──
(function(){ const words='Guidance for 5G Network Anomaly Detection and Automated Root Cause Analysis on AWS'.split(' '); let line='', first=true; const max=52;
  const t=[`<text x="${x(0.12)}" y="${x(0.36)}" font-family="${FF}" font-size="23" font-weight="bold" fill="${DARK}">`];
  words.forEach(w=>{ if((line+' '+w).trim().length>max){ t.push(`<tspan x="${x(0.12)}" dy="${first?0:27}">${esc(line)}</tspan>`); line=w; first=false; } else line=(line?line+' ':'')+w; });
  t.push(`<tspan x="${x(0.12)}" dy="${first?0:27}">${esc(line)}</tspan></text>`); S.push(t.join(''));
})();
const desc = 'Amazon Managed Service for Prometheus applies Random Cut Forest anomaly detection to a live 5G core. When an anomaly fires, an AWS Lambda function forwards the alert to the AWS DevOps Agent, which autonomously investigates and identifies the failing network function.';
// wrap description across ~2 lines
(function(){ const words=desc.split(' '); let line='', ly=x(0.98); const max=150;
  const t=[`<text x="${x(0.12)}" y="${ly}" font-family="${FF}" font-size="13.5" fill="${GRAY}">`];
  let first=true;
  words.forEach(w=>{ if((line+' '+w).trim().length>max){ t.push(`<tspan x="${x(0.12)}" dy="${first?0:16}">${esc(line)}</tspan>`); line=w; first=false; } else line=(line?line+' ':'')+w; });
  t.push(`<tspan x="${x(0.12)}" dy="${first?0:16}">${esc(line)}</tspan></text>`); S.push(t.join(''));
})();
S.push(`<line x1="${x(0.12)}" y1="${x(1.30)}" x2="${x(0.12+9.42)}" y2="${x(1.30)}" stroke="${GRAY}" stroke-width="2.7"/>`);

// ── grey sidebar with numbered callouts ──
const sbX=9.82, sbW=3.52;
S.push(`<rect x="${x(sbX)}" y="0" width="${x(sbW)}" height="${H}" fill="${SIDEBAR}"/>`);
const steps = [
  '**Amazon Elastic Kubernetes Service (Amazon EKS)** hosts the open5gs 5G core and the UERANSIM radio access network (100 gNodeBs, 1,000 UEs), which emit registration and session metrics.',
  'A Prometheus agent scrapes the metrics and remote-writes them to **Amazon Managed Service for Prometheus** using SigV4 signing and IAM Roles for Service Accounts.',
  '**Amazon Managed Service for Prometheus** runs a Random Cut Forest (RCF) anomaly detector on the registered-subscriber count, emitting an anomaly score every 30 seconds.',
  'When the score crosses the threshold, Alertmanager publishes to an **Amazon Simple Notification Service (Amazon SNS)** topic.',
  '**Amazon SNS** invokes the forwarder **AWS Lambda** function.',
  '**AWS Lambda** reads the DevOps Agent webhook URL and token from **AWS Secrets Manager** and posts the incident (it does not investigate).',
  '**AWS Lambda** posts the incident to the **AWS DevOps Agent**, which runs the full autonomous investigation: it queries **Amazon Managed Service for Prometheus** (via a Model Context Protocol server on **Amazon API Gateway**, secured by **Amazon Cognito**) and inspects **Amazon EKS** to pinpoint the failed network function.',
  'Engineers run the guided demo and interactive analysis from an **Amazon SageMaker** notebook.',
];
function toks(s){ const o=[]; s.split('**').forEach((seg,i)=>{ const b=i%2===1; seg.split(/\s+/).forEach(w=>{ if(w) o.push({w,b}); }); }); return o; }
const top=0.16, slot=(7.5-top-0.1)/steps.length, fsz=9.5, lh=11.8, maxC=50;
steps.forEach((s,i)=>{
  const cy=top+i*slot;
  // number circle
  S.push(`<circle cx="${x(sbX+0.08+0.15)}" cy="${x(cy+0.02+0.15)}" r="${x(0.15)}" fill="${DARK}"/>`);
  S.push(`<text x="${x(sbX+0.08+0.15)}" y="${x(cy+0.02+0.15)+3.5}" font-family="${FF}" font-size="11" font-weight="bold" fill="${WHITE}" text-anchor="middle">${i+1}</text>`);
  // wrapped text with bold service names
  const tx=x(sbX+0.46), ty=x(cy)+11;
  const lines=[]; let cur=[], len=0;
  toks(s).forEach(t=>{ const add=(cur.length?1:0)+t.w.length; if(len+add>maxC && cur.length){ lines.push(cur); cur=[t]; len=t.w.length; } else { cur.push(t); len+=add; } });
  if(cur.length) lines.push(cur);
  const sp=[]; lines.forEach((ln,li)=>{ ln.forEach((t,wi)=>{ const first=wi===0; const a=[]; if(first){ a.push(`x="${tx}"`); a.push(`dy="${li===0?fsz:lh}"`);} if(t.b) a.push('font-weight="bold"'); sp.push(`<tspan ${a.join(' ')}>${first?'':' '}${esc(t.w)}</tspan>`); }); });
  S.push(`<text y="${ty}" font-family="${FF}" font-size="${fsz}" fill="${DARK}" xml:space="preserve">${sp.join('')}</text>`);
});

// ── helpers ──
function group(gx,gy,gw,gh,label,color,dash,ldx){
  S.push(`<rect x="${x(gx)}" y="${x(gy)}" width="${x(gw)}" height="${x(gh)}" fill="none" stroke="${color}" stroke-width="1.7"${dash?' stroke-dasharray="6 4"':''}/>`);
  S.push(`<text x="${x(gx+(ldx||0.12))}" y="${x(gy+0.22)}" font-family="${FF}" font-size="12" font-weight="bold" fill="${color}">${esc(label)}</text>`);
}
function box(bx,by,bw,bh,label,bg,border,size){
  S.push(`<rect x="${x(bx)}" y="${x(by)}" width="${x(bw)}" height="${x(bh)}" fill="${bg}" stroke="${border}" stroke-width="1.3"/>`);
  const parts=label.split('\n'); const cx=x(bx+bw/2); const cy=x(by+bh/2)-((parts.length-1)*(size+1))/2+ (size*0.35);
  const t=[`<text x="${cx}" y="${cy}" font-family="${FF}" font-size="${size}" font-weight="bold" fill="${DARK}" text-anchor="middle">`];
  parts.forEach((p,j)=> t.push(`<tspan x="${cx}" dy="${j?size+2:0}">${esc(p)}</tspan>`));
  t.push('</text>'); S.push(t.join(''));
}
function svc(cx,iy,icon,label,size){
  const iw=0.6; S.push(`<image x="${x(cx-iw/2)}" y="${x(iy)}" width="${x(iw)}" height="${x(iw)}" href="data:image/png;base64,${b64(icon)}"/>`);
  const parts=label.split('\n'); const lx=x(cx); let ly=x(iy+iw+0.14);
  const t=[`<text x="${lx}" y="${ly}" font-family="${FF}" font-size="${size||9}" fill="${DARK}" text-anchor="middle">`];
  parts.forEach((p,j)=> t.push(`<tspan x="${lx}" dy="${j?(size||9)+2:0}">${esc(p)}</tspan>`));
  t.push('</text>'); S.push(t.join(''));
}
function cnum(cx,cy,n){
  S.push(`<circle cx="${x(cx+0.13)}" cy="${x(cy+0.13)}" r="${x(0.13)}" fill="${DARK}"/>`);
  S.push(`<text x="${x(cx+0.13)}" y="${x(cy+0.13)+3}" font-family="${FF}" font-size="10" font-weight="bold" fill="${WHITE}" text-anchor="middle">${n}</text>`);
}
function arrow(x1,y1,x2,y2,color,mk){
  S.push(`<line x1="${x(x1)}" y1="${x(y1)}" x2="${x(x2)}" y2="${x(y2)}" stroke="${color}" stroke-width="1.7" marker-end="url(#${mk})"/>`);
}

// ── groups ──
group(0.20,1.42,9.34,5.55,'AWS Cloud',DARK,false);
group(0.36,1.80,9.02,5.02,'Region (us-east-1)',TEAL,true);

// Column 1: EKS cluster + SageMaker
group(0.52,2.18,3.02,3.05,'Amazon EKS · open5gs-amp-cluster',ORANGE,false,0.42);
S.push(`<image x="${x(0.58)}" y="${x(2.21)}" width="${x(0.28)}" height="${x(0.28)}" href="data:image/png;base64,${b64('AmazonElasticKubernetesService')}"/>`);
box(0.64,2.58,2.78,0.5,'UERANSIM RAN\n100 gNodeBs · 1,000 UEs',WHITE,GRAY,9);
box(0.64,3.16,2.78,0.72,'open5gs 5G Core\nAMF · SMF · 4x UPF · NRF/UDM/PCF',WHITE,GRAY,9);
box(0.64,3.96,2.78,0.62,'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)',GREENBG,GREEN,9);
cnum(0.40,2.30,1);
svc(1.55,5.55,'AmazonSageMaker','Amazon SageMaker\nDemo notebook',9);
cnum(0.86,5.58,8);

// Column 2: AMP + RCF, Secrets Manager, MCP
svc(4.70,2.30,'AmazonManagedServiceforPrometheus','Amazon Managed Service\nfor Prometheus',9);
box(3.95,3.52,1.95,0.5,'RCF anomaly detector\nscore > 0.1 · 30s',GREENBG,GREEN,8.5);
cnum(4.02,2.24,2); cnum(5.24,2.24,3);
svc(4.70,4.30,'AWSSecretsManager','AWS Secrets Manager\nwebhook url + token',9);
cnum(4.02,4.24,6);
group(3.88,5.48,2.55,1.05,'Prometheus MCP (on-demand query)',PURPLE,false);
svc(4.42,5.82,'AmazonCognito','Amazon\nCognito',8);
svc(5.20,5.82,'AmazonAPIGateway','Amazon API\nGateway',8);
svc(5.98,5.82,'AWSLambda','AWS\nLambda',8);

// Column 3: SNS, Lambda (RCA), DevOps Agent
svc(7.85,2.30,'AmazonSimpleNotificationService','Amazon SNS\nRCA trigger topic',9);
cnum(7.17,2.24,4);
svc(7.85,4.00,'AWSLambda','AWS Lambda\nincident forwarder',9);
cnum(7.17,3.94,5);
svc(7.85,5.55,'AWSDevOpsAgent','AWS DevOps Agent\nautonomous investigation',9);
cnum(7.17,5.49,7);

// ── arrows (marker-end points at the target) ──
arrow(3.54,2.60,4.42,2.60,GREEN,'aG');    // 2: EKS -> AMP
arrow(5.60,2.60,7.28,2.60,GRAY,'aGray');  // 4: AMP -> SNS
arrow(7.85,2.98,7.85,4.02,PURPLE,'aP');   // 5: SNS -> Lambda
arrow(5.30,4.60,7.28,4.60,RED,'aR');      // 7: Secrets Manager -> Lambda
arrow(7.85,4.68,7.85,5.55,PURPLE,'aP');   // 8: Lambda -> DevOps Agent
arrow(7.85,5.95,6.46,5.95,PURPLE,'aP');   // DevOps Agent -> MCP (query)

// ── footer ──
S.push(`<text x="${x(0.12)}" y="${x(7.34)}" font-family="${FF}" font-size="9" fill="${GRAY}">© 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${S.join('\n')}\n</svg>\n`;
fs.writeFileSync(out, svg);
console.log('Wrote', out, '(' + (svg.length/1024).toFixed(0) + ' KB)');
