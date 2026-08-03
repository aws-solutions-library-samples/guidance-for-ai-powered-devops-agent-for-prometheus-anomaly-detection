/*
 * AWS Guidance-format reference architecture (single slide, 13.33x7.5) for the
 * 5G RCF anomaly-detection + automated RCA solution. Follows the official
 * guidance-architecture-diagram-template conventions (title+description over a
 * separator, grey right panel with numbered callouts, AWS Cloud>Region grouping,
 * straight/right-angle 1.25pt open arrows, Arial, footer).
 *
 * Colored boxes are placeholders for official AWS Architecture Icons — swap them
 * in PowerPoint for final publish (Approach B in the aws-guidance-pptx skill).
 *
 * Run: node docs/diagrams/generate-guidance-pptx.cjs <out.pptx>
 */
const pptxgen = require('/opt/homebrew/lib/node_modules/pptxgenjs');
const out = process.argv[2] || '5g-rcf-architecture-guidance.pptx';
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
const S = pptx.ShapeType;
const slide = pptx.addSlide();

const DARK='232F3E', ORANGE='FF9900', BLUE='0972D3', GREEN='1B8B1B', PURPLE='7C3AED',
      RED='D13212', GRAY='666666', WHITE='FFFFFF',
      GREENBG='DCEEDC', ORANGEBG='FFE9CC', PURPLEBG='ECE3FB', REDBG='FBE2DC', BLUEBG='DCEBFA', GREYBG='F5F5F5';
const F='Arial';

// Title + description + separator
slide.addText('Guidance for 5G Network Anomaly Detection and Automated Root Cause Analysis on AWS',
  { x:0.3, y:0.12, w:8.4, h:0.35, fontSize:14, bold:true, fontFace:F, color:DARK });
slide.addText('Amazon Managed Service for Prometheus applies Random Cut Forest anomaly detection to a live 5G core, then runs an automated root-cause-analysis pipeline that identifies the failing network function and hands the incident to the AWS DevOps Agent.',
  { x:0.3, y:0.47, w:8.4, h:0.28, fontSize:9, fontFace:F, color:GRAY });
slide.addShape(S.line, { x:0.3, y:0.78, w:12.7, h:0, line:{ color:'CCCCCC', width:1 } });

// Right panel + numbered callouts
const rpX=8.95, rpY=0.85, rpW=4.35, rpH=6.2;
slide.addShape(S.rect, { x:rpX, y:rpY, w:rpW, h:rpH, fill:{color:GREYBG}, line:{color:'E0E0E0', width:0.5} });
const steps = [
  '**Amazon Elastic Kubernetes Service (Amazon EKS)** hosts the open5gs 5G core (AMF, SMF, UPF) and the UERANSIM radio access network (100 gNodeBs, 1,000 UEs), which emit registration and session metrics.',
  'A Prometheus agent scrapes the metrics and remote-writes them to **Amazon Managed Service for Prometheus** using SigV4 signing and IAM Roles for Service Accounts.',
  '**Amazon Managed Service for Prometheus** runs a Random Cut Forest (RCF) anomaly detector on the aggregate registered-subscriber count, emitting an anomaly score every 30 seconds.',
  'When the score crosses the threshold, the alerting rule fires and Alertmanager publishes to an **Amazon Simple Notification Service (Amazon SNS)** topic.',
  '**Amazon SNS** invokes the root-cause-analysis **AWS Lambda** function.',
  'The **AWS Lambda** function queries **Amazon Managed Service for Prometheus** for per-network-function registration and pod restarts to pinpoint the failed function.',
  'The function retrieves the DevOps Agent webhook URL and token from **AWS Secrets Manager**.',
  'The function posts an incident to the **AWS DevOps Agent** for autonomous investigation; the agent can also query metrics on demand through a Model Context Protocol server on **Amazon API Gateway**, secured by **Amazon Cognito**.',
  'Engineers run the guided demo and interactive analysis from an **Amazon SageMaker** notebook.',
];
const stepH = (rpH-0.2)/steps.length;
steps.forEach((s,i)=>{
  const y = rpY + 0.1 + i*stepH;
  slide.addText(String(i+1), { x:rpX+0.1, y:y+0.03, w:0.26, h:0.26, fontSize:9, bold:true, fontFace:F,
    color:WHITE, fill:{color:ORANGE}, align:'center', valign:'middle', shape:S.ellipse });
  slide.addText(s, { x:rpX+0.46, y:y, w:rpW-0.58, h:stepH-0.03, fontSize:8, fontFace:F, color:DARK, valign:'top' });
});

// AWS Cloud > Region grouping
slide.addShape(S.rect, { x:0.3, y:0.85, w:8.45, h:6.2, fill:{type:'solid',color:WHITE,transparency:100}, line:{color:DARK, width:1.25, dashType:'dash'} });
slide.addText('AWS Cloud', { x:0.4, y:0.87, w:1.2, h:0.2, fontSize:8, bold:true, fontFace:F, color:DARK });
slide.addShape(S.rect, { x:0.5, y:1.15, w:8.1, h:5.8, fill:{type:'solid',color:WHITE,transparency:100}, line:{color:BLUE, width:1, dashType:'dash'} });
slide.addText('Region (us-east-1)', { x:0.6, y:1.17, w:1.8, h:0.2, fontSize:8, bold:true, fontFace:F, color:BLUE });

function box(x,y,w,h,label,bg,border,fs){
  slide.addText(label, { x, y, w, h, fontSize:fs||9, bold:true, fontFace:F, color:DARK, align:'center',
    valign:'middle', fill:{color:bg}, line:{color:border, width:1} });
}
function callout(x,y,n){
  slide.addText(String(n), { x, y, w:0.24, h:0.24, fontSize:8.5, bold:true, fontFace:F, color:WHITE,
    fill:{color:ORANGE}, align:'center', valign:'middle', shape:S.ellipse });
}
function seg(x,y,w,h,color,head){ // straight segment; head: 'end'|'begin'|null
  slide.addShape(S.line, { x, y, w, h, line:{ color:color||GRAY, width:1.25,
    ...(head==='end'?{endArrowType:'triangle'}:{}), ...(head==='begin'?{beginArrowType:'triangle'}:{}) } });
}

// Amazon EKS group
slide.addShape(S.rect, { x:0.7, y:1.5, w:3.05, h:2.95, fill:{type:'solid',color:BLUEBG,transparency:65}, line:{color:ORANGE, width:1} });
slide.addText('Amazon EKS  ·  open5gs-amp-cluster', { x:0.78, y:1.53, w:2.9, h:0.2, fontSize:8, bold:true, fontFace:F, color:DARK });
box(0.85,1.8,2.75,0.55,'UERANSIM RAN\n100 gNodeBs · 1,000 UEs', ORANGEBG, ORANGE, 8.5);
box(0.85,2.45,2.75,0.85,'open5gs 5G Core\nAMF · SMF · 4x UPF · NRF/UDM/PCF', ORANGEBG, ORANGE, 8);
box(0.85,3.4,2.75,0.85,'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)', GREENBG, GREEN, 8);
callout(0.56,1.7,1);

// Amazon Managed Service for Prometheus
box(4.15,1.6,2.35,0.9,'Amazon Managed\nService for Prometheus', GREENBG, GREEN, 9);
box(4.15,2.6,2.35,0.62,'RCF anomaly detector\nscore > 0.1 · 30s', GREENBG, GREEN, 8);
callout(3.9,1.66,2); callout(4.2,2.66,3);

// Amazon SNS
box(6.85,1.6,1.75,0.9,'Amazon SNS\nRCA trigger topic', PURPLEBG, PURPLE, 8.5);
callout(6.66,1.66,4);

// RCA AWS Lambda
box(6.85,3.0,1.75,0.9,'AWS Lambda\nRoot-cause analysis', ORANGEBG, ORANGE, 8.5);
callout(6.66,3.06,5); callout(6.5,2.9,6);

// AWS Secrets Manager
box(4.15,3.55,1.95,0.8,'AWS Secrets Manager\nagent webhook url + token', REDBG, RED, 8);
callout(5.9,3.5,7);

// AWS DevOps Agent
box(6.85,4.45,1.75,0.9,'AWS DevOps Agent\nautonomous investigation', PURPLEBG, PURPLE, 8.5);
callout(6.66,4.51,8);

// Amazon SageMaker (bottom-left)
box(0.7,5.1,2.6,0.9,'Amazon SageMaker\nDemo notebook', BLUEBG, BLUE, 8.5);
callout(0.56,5.16,9);

// Prometheus MCP (bottom-right)
slide.addShape(S.rect, { x:5.4, y:5.55, w:3.2, h:1.3, fill:{type:'solid',color:PURPLEBG,transparency:60}, line:{color:PURPLE, width:1} });
slide.addText('Prometheus MCP server (on-demand query)', { x:5.48, y:5.58, w:3.05, h:0.2, fontSize:8, bold:true, fontFace:F, color:DARK });
box(5.5,5.85,0.95,0.85,'Amazon\nCognito', PURPLEBG, PURPLE, 8);
box(6.55,5.85,1.0,0.85,'Amazon API\nGateway', PURPLEBG, PURPLE, 8);
box(7.65,5.85,0.85,0.85,'AWS\nLambda', ORANGEBG, ORANGE, 8);

// Arrows (straight + right angles; 1.25pt open arrows)
seg(3.75,2.05,0.4,0,GREEN,'end');       // (2) EKS -> AMP remote_write
seg(6.5,2.05,0.35,0,GREEN,'end');       // (4) AMP -> SNS alert
seg(7.72,2.5,0,0.5,PURPLE,'end');       // (5) SNS -> RCA Lambda
seg(6.5,3.15,0.35,0,BLUE,'begin');      // (6) Lambda -> AMP query (points left into AMP)
seg(6.1,3.75,0.75,0,RED,'end');         // (7) Secrets Manager -> Lambda
seg(7.72,3.9,0,0.55,PURPLE,'end');      // (8) Lambda -> DevOps Agent
seg(7.72,5.35,0,0.2,PURPLE,'end');      // DevOps Agent -> MCP
seg(6.3,3.22,0,2.33,BLUE,'begin');      // MCP -> AMP query (points up into RCF bottom)
// (9) SageMaker -> AMP query: right to corridor x3.9, up, right into AMP left
seg(3.3,5.5,0.6,0,BLUE,null);
seg(3.9,2.05,0,3.45,BLUE,null);
seg(3.9,2.05,0.25,0,BLUE,'end');

// Footer
slide.addText('Placeholder boxes represent AWS service icons — replace with official AWS Architecture Icons before publishing.',
  { x:0.3, y:7.0, w:8.4, h:0.16, fontSize:6, italic:true, fontFace:F, color:'AAAAAA' });
slide.addText('© 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.',
  { x:0.3, y:7.2, w:8.4, h:0.2, fontSize:6.5, fontFace:F, color:GRAY });

pptx.writeFile({ fileName: out }).then(()=>console.log('Wrote', out));
