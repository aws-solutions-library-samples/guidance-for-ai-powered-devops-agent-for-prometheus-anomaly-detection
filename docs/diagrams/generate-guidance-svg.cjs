/*
 * SVG/PNG twin of generate-guidance-pptx.cjs — SAME coordinates, labels, fonts and
 * colours, so the README image never drifts from the reviewed PPTX. (It did once:
 * the SVG kept a stale "RCA trigger topic" label after the SNS topic was renamed.)
 * Official AWS icons are embedded as base64 so the SVG renders standalone and
 * converts cleanly with rsvg-convert.
 *
 * Keep in sync with the PPTX generator. Regenerate both via docs/diagrams/regenerate.sh.
 * Run: node docs/diagrams/generate-guidance-svg.cjs <out.svg>
 */
const fs = require('fs'), path = require('path');
const out = process.argv[2] || path.join(__dirname, '5g-rcf-architecture-guidance.svg');
const IN = 96;                                   // px per inch
const W = 13.333 * IN, H = 7.5 * IN;
const DARK='#232F3E', TEAL='#00A4A6', ORANGE='#FF9900', GREEN='#1B8B1B', PURPLE='#7C3AED',
      BLACK='#000000', GRAY='#545B64', WHITE='#FFFFFF', GREENBG='#DCEEDC', SIDEBAR='#EAEDED';
const FF='Arial, Helvetica, sans-serif';
const P = i => +(i*IN).toFixed(1);               // inches -> px
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const b64 = f => fs.readFileSync(path.join(__dirname,'icons',f+'.png')).toString('base64');
const S=[];

S.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${WHITE}"/>`);
S.push(`<defs><marker id="aK" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,3 L0,6" fill="none" stroke="${BLACK}" stroke-width="1.4"/></marker></defs>`);

// wrap helper: returns tspans for `text` at x, starting at font size fs
function wrap(text, x, fs, maxChars, lead, opts={}){
  const words=text.split(' '); const lines=[]; let cur='';
  words.forEach(w=>{ if((cur+' '+w).trim().length>maxChars && cur){ lines.push(cur); cur=w; } else cur=(cur?cur+' ':'')+w; });
  if(cur) lines.push(cur);
  return lines.map((l,i)=>`<tspan x="${x}" dy="${i===0?0:lead}"${opts.italic?' font-style="italic"':''}>${esc(l)}</tspan>`).join('');
}

// ── Title 24pt bold + description 12pt black + separator (mirrors PPTX) ──
S.push(`<text y="${P(0.34)}" font-family="${FF}" font-size="32" font-weight="bold" fill="${DARK}">`+
  wrap('Guidance for 5G Network Anomaly Detection and Automated Root Cause Analysis on AWS', P(0.12), 32, 52, 40)+`</text>`);
S.push(`<text y="${P(0.94)}" font-family="${FF}" font-size="16" fill="${BLACK}">`+
  wrap('This architecture diagram shows how Amazon Managed Service for Prometheus detects 5G core anomalies and automatically triggers the AWS DevOps Agent to investigate and identify the failing network function.', P(0.12), 16, 108, 21)+`</text>`);
S.push(`<line x1="${P(0.12)}" y1="${P(1.30)}" x2="${P(9.54)}" y2="${P(1.30)}" stroke="${GRAY}" stroke-width="2.7"/>`);

// ── Grey sidebar (3.52 x 7.5) + 8 numbered steps at 9pt black ──
const sbX=9.82, sbW=3.52;
S.push(`<rect x="${P(sbX)}" y="0" width="${P(sbW)}" height="${H}" fill="${SIDEBAR}"/>`);
const steps=[
 '**Amazon Elastic Kubernetes Service (Amazon EKS)** hosts the open5gs 5G core and the UERANSIM radio access network (100 gNodeBs, 1,000 user equipment), which emit registration and session metrics.',
 'A Prometheus agent scrapes the metrics and remote-writes them to **Amazon Managed Service for Prometheus** using SigV4 signing and IAM Roles for Service Accounts.',
 '**Amazon Managed Service for Prometheus** runs a Random Cut Forest (RCF) anomaly detector on the registered-subscriber count, emitting an anomaly score every 30 seconds.',
 'When the score crosses the threshold, Alertmanager publishes to an **Amazon Simple Notification Service (Amazon SNS)** topic.',
 '**Amazon SNS** invokes the forwarder **AWS Lambda** function.',
 '**AWS Lambda** reads the DevOps Agent webhook URL and token from **AWS Secrets Manager**, then posts the incident. It does not investigate.',
 '**AWS Lambda** posts the incident to the **AWS DevOps Agent**, which investigates autonomously: it queries **Amazon Managed Service for Prometheus** through a Model Context Protocol server on **Amazon API Gateway**, secured by **Amazon Cognito**.',
 'Engineers run the guided demo and interactive analysis from an **Amazon SageMaker** notebook.',
];
function toks(s){ const o=[]; s.split('**').forEach((seg,i)=>{ const b=i%2===1; seg.split(/\s+/).forEach(w=>{ if(w) o.push({w,b}); }); }); return o; }
const top=0.16, slot=(7.5-top-0.10)/steps.length, FS=12, LEAD=14, MAXC=44;
steps.forEach((s,i)=>{
  const cy=top+i*slot;
  S.push(`<circle cx="${P(sbX+0.23)}" cy="${P(cy+0.17)}" r="${P(0.15)}" fill="${DARK}"/>`);
  S.push(`<text x="${P(sbX+0.23)}" y="${P(cy+0.17)+4}" font-family="${FF}" font-size="12" font-weight="bold" fill="${WHITE}" text-anchor="middle">${i+1}</text>`);
  const tx=P(sbX+0.46); const lines=[]; let cur=[], len=0;
  toks(s).forEach(t=>{ const add=(cur.length?1:0)+t.w.length; if(len+add>MAXC && cur.length){ lines.push(cur); cur=[t]; len=t.w.length; } else { cur.push(t); len+=add; } });
  if(cur.length) lines.push(cur);
  const sp=[]; lines.forEach((ln,li)=> ln.forEach((t,wi)=>{
    const a=[]; if(wi===0){ a.push(`x="${tx}"`); a.push(`dy="${li===0?FS:LEAD}"`); }
    if(t.b) a.push('font-weight="bold"');
    sp.push(`<tspan ${a.join(' ')}>${wi?' ':''}${esc(t.w)}</tspan>`);
  }));
  S.push(`<text y="${P(cy)}" font-family="${FF}" font-size="${FS}" fill="${BLACK}" xml:space="preserve">${sp.join('')}</text>`);
});

// ── helpers mirroring the PPTX ──
function grpCustom(x,y,w,h,label,color,icon,dash){
  S.push(`<rect x="${P(x)}" y="${P(y)}" width="${P(w)}" height="${P(h)}" fill="none" stroke="${color}" stroke-width="1.7"${dash?' stroke-dasharray="6 4"':''}/>`);
  if(icon) S.push(`<image x="${P(x+0.05)}" y="${P(y+0.04)}" width="${P(0.32)}" height="${P(0.32)}" href="data:image/png;base64,${b64(icon)}"/>`);
  S.push(`<text x="${P(x+(icon?0.42:0.12))}" y="${P(y+0.22)}" font-family="${FF}" font-size="12" font-weight="bold" fill="${color}">${esc(label)}</text>`);
}
function grpGeneric(x,y,w,h,label,color){         // multi-service group: name centred at top
  S.push(`<rect x="${P(x)}" y="${P(y)}" width="${P(w)}" height="${P(h)}" fill="none" stroke="${color}" stroke-width="1.7"/>`);
  S.push(`<text x="${P(x+w/2)}" y="${P(y+0.22)}" font-family="${FF}" font-size="12" font-weight="bold" fill="${color}" text-anchor="middle">${esc(label)}</text>`);
}
function box(x,y,w,h,label,bg,border){
  S.push(`<rect x="${P(x)}" y="${P(y)}" width="${P(w)}" height="${P(h)}" fill="${bg}" stroke="${border}" stroke-width="1.3"/>`);
  const parts=label.split('\n'), cx=P(x+w/2);
  const cy=P(y+h/2)-((parts.length-1)*7)+4;
  S.push(`<text x="${cx}" y="${cy}" font-family="${FF}" font-size="12" font-weight="bold" fill="${BLACK}" text-anchor="middle">`+
    parts.map((t,j)=>`<tspan x="${cx}" dy="${j?14:0}">${esc(t)}</tspan>`).join('')+`</text>`);
}
function svc(cx,y,icon,label){                    // 0.6" icon + 9pt label, sub-label ITALIC
  const iw=0.6;
  S.push(`<image x="${P(cx-iw/2)}" y="${P(y)}" width="${P(iw)}" height="${P(iw)}" href="data:image/png;base64,${b64(icon)}"/>`);
  const parts=label.split('\n'), lx=P(cx);
  const t=[`<text x="${lx}" y="${P(y+iw+0.17)}" font-family="${FF}" font-size="12" fill="${BLACK}" text-anchor="middle">`];
  parts.forEach((s,j)=> t.push(`<tspan x="${lx}" dy="${j?14:0}"${j?' font-style="italic"':''}>${esc(s)}</tspan>`));
  t.push('</text>'); S.push(t.join(''));
}
function cnum(x,y,n){
  S.push(`<circle cx="${P(x+0.13)}" cy="${P(y+0.13)}" r="${P(0.13)}" fill="${DARK}"/>`);
  S.push(`<text x="${P(x+0.13)}" y="${P(y+0.13)+4}" font-family="${FF}" font-size="12" font-weight="bold" fill="${WHITE}" text-anchor="middle">${n}</text>`);
}
function seg(x,y,w,h,head){                       // solid black 1.25pt, straight only
  const x2=x+w, y2=y+h;
  const a = head==='begin' ? `x1="${P(x2)}" y1="${P(y2)}" x2="${P(x)}" y2="${P(y)}"` : `x1="${P(x)}" y1="${P(y)}" x2="${P(x2)}" y2="${P(y2)}"`;
  S.push(`<line ${a} stroke="${BLACK}" stroke-width="1.7" marker-end="url(#aK)"/>`);
}

// ── layout (identical coordinates to the PPTX) ──
grpCustom(0.20,1.42,9.34,5.55,'AWS Cloud',DARK,null,false);
grpCustom(0.36,1.80,9.02,5.02,'Region (us-east-1)',TEAL,null,true);

grpCustom(0.52,2.18,3.02,3.05,'Amazon EKS \u00b7 open5gs-amp-cluster',ORANGE,'AmazonElasticKubernetesService',false);
box(0.64,2.62,2.78,0.48,'UERANSIM RAN \u2014 100 gNodeBs \u00b7 1,000 UEs',WHITE,GRAY);
box(0.64,3.18,2.78,0.70,'open5gs 5G Core\nAMF \u00b7 SMF \u00b7 4x UPF \u00b7 NRF/UDM/PCF',WHITE,GRAY);
box(0.64,3.96,2.78,0.62,'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)',GREENBG,GREEN);
cnum(0.40,2.30,1);

svc(4.70,2.30,'AmazonManagedServiceforPrometheus','Amazon Managed Service\nfor Prometheus');
box(3.95,3.52,1.95,0.58,'RCF anomaly detector\nscore > 0.1 \u00b7 every 30s',GREENBG,GREEN);
cnum(4.02,2.24,2); cnum(5.24,2.24,3);

svc(7.85,2.30,'AmazonSimpleNotificationService','Amazon SNS\nalert trigger topic');   cnum(7.17,2.24,4);
svc(7.85,4.00,'AWSLambda','AWS Lambda\nincident forwarder');                          cnum(7.17,3.94,5);
svc(6.30,4.30,'AWSSecretsManager','AWS Secrets Manager\nwebhook URL + token');        cnum(5.62,4.24,6);
svc(7.85,5.55,'AWSDevOpsAgent','AWS DevOps Agent\nautonomous investigation');         cnum(7.17,5.49,7);
svc(1.55,5.55,'AmazonSageMaker','Amazon SageMaker\ndemo notebook');                    cnum(0.86,5.58,8);

grpGeneric(3.60,5.35,3.30,1.45,'Prometheus MCP \u2014 on-demand metric queries',PURPLE);
svc(4.25,5.62,'AmazonCognito','Amazon Cognito\nM2M OAuth2');
svc(5.35,5.62,'AmazonAPIGateway','Amazon API\nGateway');
svc(6.50,5.62,'AWSLambda','AWS Lambda\nMCP server');

seg(3.54,2.60,1.16,0,'end');
seg(5.90,2.60,1.35,0,'end');
seg(7.85,2.95,0,1.05,'end');
seg(6.60,4.60,0.95,0,'end');
seg(7.85,4.66,0,0.89,'end');
seg(6.90,5.95,0.95,0,'begin');

S.push(`<text x="${P(0.12)}" y="${P(7.38)}" font-family="${FF}" font-size="12" fill="${GRAY}">\u00a9 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.</text>`);

fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${S.join('\n')}\n</svg>\n`);
console.log('Wrote', out);
