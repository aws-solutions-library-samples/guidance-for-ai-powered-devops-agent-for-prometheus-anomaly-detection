/*
 * AWS Guidance reference architecture (single slide, 13.33x7.5) for the 5G RCF
 * anomaly-detection + automated RCA solution. Rewritten to comply with the
 * OFFICIAL AWS "guidance-architecture-diagram-template" format:
 *   - Title (28pt) + description over a 2pt #545B64 separator (left area only)
 *   - Grey (#EAEDED) sidebar at x=9.82 w=3.52 full-height, with numbered callouts
 *     (bold AWS service names, acronyms spelled out on first use)
 *   - AWS Cloud (squid-ink solid) > Region (teal #00A4A6 dashed) grouping
 *   - Official AWS Architecture Icons (docs/diagrams/icons/*.png), labels below
 *   - Straight / right-angle Open Arrows (1.25pt), Arial throughout, footer
 * Non-AWS/third-party elements (open5gs, UERANSIM, Prometheus agent) are labeled
 * boxes (names only, no logos).
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

// Template palette
const DARK='232F3E', TEAL='00A4A6', ORANGE='FF9900', GREEN='1B8B1B', PURPLE='7C3AED',
      RED='D13212', GRAY='545B64', WHITE='FFFFFF',
      GREENBG='DCEEDC', SIDEBAR='EAEDED';
const F='Arial';

// bold **service names** -> pptxgenjs rich-text runs (pptxgen does NOT parse markdown)
function runs(s){
  return s.split(/\*\*/).map((t,i)=>({ text:t, options:{ bold:i%2===1 } })).filter(r=>r.text.length);
}

// ── Title + description over the separator (left area only) ──
slide.addText('Guidance for 5G Network Anomaly Detection and Automated Root Cause Analysis on AWS',
  { x:0.12, y:0.10, w:9.45, h:0.72, fontSize:20, bold:true, fontFace:F, color:DARK, valign:'top' });
slide.addText('Amazon Managed Service for Prometheus applies Random Cut Forest anomaly detection to a live 5G core, then an automated root-cause-analysis pipeline identifies the failing network function and hands the incident to the AWS DevOps Agent for an autonomous investigation.',
  { x:0.12, y:0.84, w:9.45, h:0.40, fontSize:10.5, fontFace:F, color:GRAY, valign:'top' });
slide.addShape(S.line, { x:0.12, y:1.30, w:9.42, h:0, line:{ color:GRAY, width:2 } });

// ── Grey sidebar (full height) with numbered callouts ──
const sbX=9.82, sbW=3.52;
slide.addShape(S.rect, { x:sbX, y:0, w:sbW, h:7.5, fill:{ color:SIDEBAR }, line:{ color:SIDEBAR, width:0 } });
const steps = [
  '**Amazon Elastic Kubernetes Service (Amazon EKS)** hosts the open5gs 5G core and the UERANSIM radio access network (100 gNodeBs, 1,000 UEs), which emit registration and session metrics.',
  'A Prometheus agent scrapes the metrics and remote-writes them to **Amazon Managed Service for Prometheus** using SigV4 signing and IAM Roles for Service Accounts.',
  '**Amazon Managed Service for Prometheus** runs a Random Cut Forest (RCF) anomaly detector on the registered-subscriber count, emitting an anomaly score every 30 seconds.',
  'When the score crosses the threshold, Alertmanager publishes to an **Amazon Simple Notification Service (Amazon SNS)** topic.',
  '**Amazon SNS** invokes the root-cause-analysis **AWS Lambda** function.',
  '**AWS Lambda** queries **Amazon Managed Service for Prometheus** for per-network-function registration and pod restarts to pinpoint the failed function.',
  '**AWS Lambda** reads the DevOps Agent webhook URL and token from **AWS Secrets Manager**.',
  '**AWS Lambda** posts an incident to the **AWS DevOps Agent**, which investigates autonomously and can query metrics through a Model Context Protocol server on **Amazon API Gateway**, secured by **Amazon Cognito**.',
  'Engineers run the guided demo and interactive analysis from an **Amazon SageMaker** notebook.',
];
const top=0.16, slot=(7.5-top-0.1)/steps.length;
steps.forEach((s,i)=>{
  const y=top+i*slot;
  slide.addText(String(i+1), { x:sbX+0.08, y:y+0.02, w:0.3, h:0.3, fontSize:9, bold:true, fontFace:F,
    color:WHITE, fill:{color:DARK}, align:'center', valign:'middle', shape:S.ellipse });
  slide.addText(runs(s), { x:sbX+0.46, y, w:sbW-0.56, h:slot-0.04, fontSize:8, fontFace:F, color:DARK, valign:'top' });
});

// ── helpers ──
function grp(x,y,w,h,label,color,dash){                       // grouping box + icon + label
  slide.addShape(S.rect, { x, y, w, h, fill:{ type:'solid', color:WHITE, transparency:100 },
    line:{ color, width:1.25, dashType: dash?'dash':'solid' } });
  slide.addText(label, { x:x+0.34, y:y+0.03, w:w-0.4, h:0.22, fontSize:9, bold:true, fontFace:F, color });
}
function box(x,y,w,h,label,bg,border,fs){                     // labeled (non-AWS) box
  slide.addText(label, { x, y, w, h, fontSize:fs||8, bold:true, fontFace:F, color:DARK, align:'center',
    valign:'middle', fill:{color:bg}, line:{color:border, width:1} });
}
function svc(cx,y,icon,label,fs){                             // AWS icon (0.6) centered on cx, label below
  const iw=0.6;
  slide.addImage({ path:IC(icon), x:cx-iw/2, y, w:iw, h:iw });
  slide.addText(label, { x:cx-1.0, y:y+iw+0.01, w:2.0, h:0.36, fontSize:fs||8, fontFace:F, color:DARK,
    align:'center', valign:'top' });
}
function cnum(x,y,n){                                          // numbered callout on the diagram
  slide.addText(String(n), { x, y, w:0.26, h:0.26, fontSize:8.5, bold:true, fontFace:F, color:WHITE,
    fill:{color:DARK}, align:'center', valign:'middle', shape:S.ellipse });
}
function seg(x,y,w,h,color,head){                             // straight/right-angle open arrow (1.25pt)
  const line={ color:color||GRAY, width:1.25 };
  if(head==='end') line.endArrowType='arrow';
  if(head==='begin') line.beginArrowType='arrow';
  slide.addShape(S.line, { x, y, w, h, line });
}

// ── AWS Cloud > Region grouping (labeled boxes; corner-icon PNGs not in set) ──
grp(0.20, 1.42, 9.34, 5.55, 'AWS Cloud', DARK, false);
grp(0.36, 1.80, 9.02, 5.02, 'Region (us-east-1)', TEAL, true);

// ── Column 1: Amazon EKS cluster group + SageMaker ──
grp(0.52, 2.18, 3.02, 3.05, 'Amazon EKS · open5gs-amp-cluster', ORANGE, false);
slide.addImage({ path:IC('AmazonElasticKubernetesService'), x:0.58, y:2.21, w:0.28, h:0.28 });
box(0.64, 2.58, 2.78, 0.5, 'UERANSIM RAN\n100 gNodeBs · 1,000 UEs', WHITE, GRAY, 8);
box(0.64, 3.16, 2.78, 0.72, 'open5gs 5G Core\nAMF · SMF · 4x UPF · NRF/UDM/PCF', WHITE, GRAY, 8);
box(0.64, 3.96, 2.78, 0.62, 'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)', GREENBG, GREEN, 8);
cnum(0.40, 2.30, 1);
svc(1.55, 5.55, 'AmazonSageMaker', 'Amazon SageMaker\nDemo notebook', 8);
cnum(0.86, 5.58, 9);

// ── Column 2: AMP (+ RCF) , Secrets Manager , MCP group ──
svc(4.70, 2.30, 'AmazonManagedServiceforPrometheus', 'Amazon Managed Service\nfor Prometheus', 8);
box(3.95, 3.52, 1.95, 0.5, 'RCF anomaly detector\nscore > 0.1 · 30s', GREENBG, GREEN, 7.5);
cnum(4.02, 2.24, 2); cnum(5.24, 2.24, 3);
svc(4.70, 4.30, 'AWSSecretsManager', 'AWS Secrets Manager\nwebhook url + token', 8);
cnum(4.02, 4.24, 7);
grp(3.88, 5.48, 2.55, 1.05, 'Prometheus MCP (on-demand query)', PURPLE, false);
svc(4.42, 5.78, 'AmazonCognito', 'Amazon\nCognito', 7);
svc(5.20, 5.78, 'AmazonAPIGateway', 'Amazon API\nGateway', 7);
svc(5.98, 5.78, 'AWSLambda', 'AWS\nLambda', 7);

// ── Column 3: SNS , Lambda (RCA) , DevOps Agent ──
svc(7.85, 2.30, 'AmazonSimpleNotificationService', 'Amazon SNS\nRCA trigger topic', 8);
cnum(7.17, 2.24, 4);
svc(7.85, 4.00, 'AWSLambda', 'AWS Lambda\nRoot-cause analysis', 8);
cnum(7.17, 3.94, 5); cnum(8.53, 3.94, 6);
svc(7.85, 5.55, 'AWSDevOpsAgent', 'AWS DevOps Agent\nautonomous investigation', 8);
cnum(7.17, 5.49, 8);

// ── Arrows (straight / right-angle, open, 1.25pt) ──
seg(3.54, 2.60, 1.16, 0, GREEN, 'end');     // 2: EKS -> AMP
seg(5.60, 2.60, 1.65, 0, GRAY, 'end');      // 4: AMP -> SNS
seg(7.85, 2.95, 0, 1.05, PURPLE, 'end');    // 5: SNS -> Lambda
seg(5.30, 4.60, 1.95, 0, RED, 'end');       // 7: Secrets Manager -> Lambda
seg(7.85, 4.66, 0, 0.89, PURPLE, 'end');    // 8: Lambda -> DevOps Agent
seg(6.43, 5.95, 1.42, 0, PURPLE, 'begin');  // DevOps Agent -> MCP (query)

// ── Footer ──
slide.addText('© 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.',
  { x:0.12, y:7.24, w:9.4, h:0.2, fontSize:7, fontFace:F, color:GRAY });

pptx.writeFile({ fileName: out }).then(()=>console.log('Wrote', out));
