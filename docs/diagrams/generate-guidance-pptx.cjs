/*
 * AWS Guidance reference architecture (single slide, 13.33x7.5) for the 5G RCF
 * anomaly-detection + DevOps Agent solution.
 *
 * Built to satisfy the Guidance Guardian Style Guide Checklist (rev 05/08/2026):
 *   - Title "Guidance for … on AWS", Arial bold 24pt (spec: 24-28pt)
 *   - Description starts "This architecture diagram shows…", <=35 words, Arial 12pt BLACK
 *   - No subhead (single-diagram Guidance)
 *   - Grey step box fixed at 3.52" x 7.5"; separator above it untouched
 *   - Narrative steps 9pt black, <=50 words each, acronyms long-form at first use,
 *     AWS service names bold
 *   - Icon labels 9pt black; sub-labels ITALIC; service icons >=0.4", grouping icons >=0.3"
 *   - "AWS"/"Amazon" on the same line as the first word of the service name
 *   - Arrows: solid BLACK, 1.25pt, straight/right-angle only (no diagonals)
 *   - Generic group (multiple services) name centred at the top; custom group (single
 *     service) icon + name in the upper-left
 *
 * Run: node docs/diagrams/generate-guidance-pptx.cjs <out.pptx>
 */
const path = require('path');
const pptxgen = require('/opt/homebrew/lib/node_modules/pptxgenjs');
const out = process.argv[2] || '5g-rcf-architecture-guidance.pptx';
const IC = (n) => path.join(__dirname, 'icons', n + '.png');
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';           // 13.33 x 7.5
const S = pptx.ShapeType;
const slide = pptx.addSlide();

const DARK='232F3E', TEAL='00A4A6', ORANGE='FF9900', GREEN='1B8B1B', PURPLE='7C3AED',
      BLACK='000000', GRAY='545B64', WHITE='FFFFFF', GREENBG='DCEEDC', SIDEBAR='EAEDED';
const F='Arial';
const ARROW=BLACK;                      // checklist: arrows must be solid black

// bold **service names** -> rich-text runs (pptxgenjs does not parse markdown)
function runs(s, base={}){
  return s.split(/\*\*/).map((t,i)=>({ text:t, options:{ ...base, bold:i%2===1 } })).filter(r=>r.text.length);
}

// ── Title (24pt bold) + description (12pt black, <=35 words) above the separator ──
slide.addText('Guidance for 5G Network Anomaly Detection and Automated Root Cause Analysis on AWS',
  { x:0.12, y:0.05, w:9.45, h:0.72, fontSize:24, bold:true, fontFace:F, color:DARK, valign:'top' });
slide.addText('This architecture diagram shows how Amazon Managed Service for Prometheus detects 5G core anomalies and automatically triggers the AWS DevOps Agent to investigate and identify the failing network function.',
  { x:0.12, y:0.80, w:9.45, h:0.40, fontSize:12, fontFace:F, color:BLACK, valign:'top' });
slide.addShape(S.line, { x:0.12, y:1.30, w:9.42, h:0, line:{ color:GRAY, width:2 } });

// ── Grey sidebar (fixed 3.52 x 7.5) with numbered narrative steps (9pt) ──
const sbX=9.82, sbW=3.52;
slide.addShape(S.rect, { x:sbX, y:0, w:sbW, h:7.5, fill:{ color:SIDEBAR }, line:{ color:SIDEBAR, width:0 } });
const steps = [
  '**Amazon Elastic Kubernetes Service (Amazon EKS)** hosts the open5gs 5G core and the UERANSIM radio access network (100 gNodeBs, 1,000 user equipment), which emit registration and session metrics.',
  'A Prometheus agent scrapes the metrics and remote-writes them to **Amazon Managed Service for Prometheus** using SigV4 signing and IAM Roles for Service Accounts.',
  '**Amazon Managed Service for Prometheus** runs a Random Cut Forest (RCF) anomaly detector on the registered-subscriber count, emitting an anomaly score every 30 seconds.',
  'When the score crosses the threshold, Alertmanager publishes to an **Amazon Simple Notification Service (Amazon SNS)** topic.',
  '**Amazon SNS** invokes the forwarder **AWS Lambda** function.',
  '**AWS Lambda** reads the DevOps Agent webhook URL and token from **AWS Secrets Manager**, then posts the incident. It does not investigate.',
  '**AWS Lambda** posts the incident to the **AWS DevOps Agent**, which investigates autonomously: it queries **Amazon Managed Service for Prometheus** through a Model Context Protocol server on **Amazon API Gateway**, secured by **Amazon Cognito**.',
  'Engineers run the guided demo and interactive analysis from an **Amazon SageMaker** notebook.',
];
const top=0.16, slot=(7.5-top-0.10)/steps.length;
steps.forEach((s,i)=>{
  const y=top+i*slot;
  slide.addText(String(i+1), { x:sbX+0.08, y:y+0.02, w:0.3, h:0.3, fontSize:9, bold:true, fontFace:F,
    color:WHITE, fill:{color:DARK}, align:'center', valign:'middle', shape:S.ellipse });
  slide.addText(runs(s), { x:sbX+0.46, y, w:sbW-0.56, h:slot-0.04, fontSize:9, fontFace:F, color:BLACK, valign:'top' });
});

// ── helpers ──
function grpGeneric(x,y,w,h,label,color){        // multiple services -> name centred at top
  slide.addShape(S.rect, { x, y, w, h, fill:{ type:'solid', color:WHITE, transparency:100 },
    line:{ color, width:1.25 } });
  slide.addText(label, { x, y:y+0.03, w, h:0.22, fontSize:9, bold:true, fontFace:F, color, align:'center' });
}
function grpCustom(x,y,w,h,label,color,icon,dash){ // single service -> icon + name upper-left
  slide.addShape(S.rect, { x, y, w, h, fill:{ type:'solid', color:WHITE, transparency:100 },
    line:{ color, width:1.25, dashType: dash?'dash':'solid' } });
  if (icon) slide.addImage({ path:IC(icon), x:x+0.05, y:y+0.04, w:0.32, h:0.32 });   // >=0.3" grouping icon
  slide.addText(label, { x:x+(icon?0.42:0.12), y:y+0.04, w:w-0.5, h:0.28, fontSize:9, bold:true,
    fontFace:F, color, valign:'middle' });
}
function box(x,y,w,h,label,bg,border){
  slide.addText(label, { x, y, w, h, fontSize:9, bold:true, fontFace:F, color:BLACK, align:'center',
    valign:'middle', fill:{color:bg}, line:{color:border, width:1} });
}
// service icon (>=0.4") + 9pt label; any line after the first is the ITALIC sub-label
function svc(cx,y,icon,label,lw,lh){
  const iw=0.6, w=lw||2.0;
  slide.addImage({ path:IC(icon), x:cx-iw/2, y, w:iw, h:iw });
  const parts=label.split('\n');
  const rt=[{ text:parts[0], options:{ fontSize:9, fontFace:F, color:BLACK, bold:false } }];
  parts.slice(1).forEach(p=> rt.push({ text:'\n'+p, options:{ fontSize:9, fontFace:F, color:BLACK, italic:true } }));
  slide.addText(rt, { x:cx-w/2, y:y+iw+0.02, w, h:lh||0.42, align:'center', valign:'top' });
}
function cnum(x,y,n){
  slide.addText(String(n), { x, y, w:0.26, h:0.26, fontSize:9, bold:true, fontFace:F, color:WHITE,
    fill:{color:DARK}, align:'center', valign:'middle', shape:S.ellipse });
}
function seg(x,y,w,h,head){                       // solid black, 1.25pt, straight only
  const line={ color:ARROW, width:1.25 };
  if(head==='end') line.endArrowType='arrow';
  if(head==='begin') line.beginArrowType='arrow';
  slide.addShape(S.line, { x, y, w, h, line });
}

// ── AWS Cloud > Region ──
grpCustom(0.20, 1.42, 9.34, 5.55, 'AWS Cloud', DARK, null, false);
grpCustom(0.36, 1.80, 9.02, 5.02, 'Region (us-east-1)', TEAL, null, true);

// ── 1. Amazon EKS (custom group: single service -> icon + name upper-left) ──
grpCustom(0.52, 2.18, 3.02, 3.05, 'Amazon EKS \u00b7 open5gs-amp-cluster', ORANGE, 'AmazonElasticKubernetesService', false);
box(0.64, 2.62, 2.78, 0.48, 'UERANSIM RAN \u2014 100 gNodeBs \u00b7 1,000 UEs', WHITE, GRAY);
box(0.64, 3.18, 2.78, 0.70, 'open5gs 5G Core\nAMF \u00b7 SMF \u00b7 4x UPF \u00b7 NRF/UDM/PCF', WHITE, GRAY);
box(0.64, 3.96, 2.78, 0.62, 'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)', GREENBG, GREEN);
cnum(0.40, 2.30, 1);

// ── 2/3. Amazon Managed Service for Prometheus + RCF detector ──
svc(4.70, 2.30, 'AmazonManagedServiceforPrometheus', 'Amazon Managed Service\nfor Prometheus', 2.4);
box(3.95, 3.52, 1.95, 0.58, 'RCF anomaly detector\nscore > 0.1 \u00b7 every 30s', GREENBG, GREEN);
cnum(4.02, 2.24, 2); cnum(5.24, 2.24, 3);

// ── 4. Amazon SNS ──
svc(7.85, 2.30, 'AmazonSimpleNotificationService', 'Amazon SNS\nalert trigger topic', 2.0);
cnum(7.17, 2.24, 4);

// ── 5. Forwarder AWS Lambda ──
svc(7.85, 4.00, 'AWSLambda', 'AWS Lambda\nincident forwarder', 1.50);
cnum(7.17, 3.94, 5);

// ── 6. AWS Secrets Manager (placed next to the Lambda so numbering stays near-linear) ──
svc(6.30, 4.30, 'AWSSecretsManager', 'AWS Secrets Manager\nwebhook URL + token', 1.50, 0.52);
cnum(5.62, 4.24, 6);

// ── 7. AWS DevOps Agent ──
svc(7.85, 5.55, 'AWSDevOpsAgent', 'AWS DevOps Agent\nautonomous investigation', 1.45, 0.52);
cnum(7.17, 5.49, 7);

// ── 8. Amazon SageMaker ──
svc(1.55, 5.55, 'AmazonSageMaker', 'Amazon SageMaker\ndemo notebook', 2.0);
cnum(0.86, 5.58, 8);

// ── Prometheus MCP (generic group: multiple services -> name centred at top) ──
grpGeneric(3.60, 5.35, 3.30, 1.45, 'Prometheus MCP \u2014 on-demand metric queries', PURPLE);
svc(4.25, 5.62, 'AmazonCognito', 'Amazon Cognito\nM2M OAuth2', 1.10);
svc(5.35, 5.62, 'AmazonAPIGateway', 'Amazon API\nGateway', 1.05);
svc(6.50, 5.62, 'AWSLambda', 'AWS Lambda\nMCP server', 1.10);

// ── Arrows: solid black, 1.25pt, straight / right-angle only ──
seg(3.54, 2.60, 1.16, 0, 'end');     // 2: EKS -> AMP
seg(5.90, 2.60, 1.35, 0, 'end');     // 4: AMP -> SNS
seg(7.85, 2.95, 0, 1.05, 'end');     // 5: SNS -> Lambda
seg(6.60, 4.60, 0.95, 0, 'end');     // 6: Secrets Manager -> Lambda
seg(7.85, 4.66, 0, 0.89, 'end');     // 7: Lambda -> DevOps Agent
seg(6.90, 5.95, 0.95, 0, 'begin');   // DevOps Agent -> MCP (queries)

// ── Footer (fixed element) ──
slide.addText('\u00a9 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.',
  { x:0.12, y:7.24, w:9.4, h:0.2, fontSize:9, fontFace:F, color:GRAY });

pptx.writeFile({ fileName: out }).then(()=>console.log('Wrote', out));
