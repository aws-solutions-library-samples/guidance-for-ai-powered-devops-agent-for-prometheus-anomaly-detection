/*
 * AWS Guidance-format reference architecture (single slide, 13.33x7.5) for the
 * 5G RCF anomaly-detection + automated RCA solution. Uses the OFFICIAL AWS
 * Architecture Icons (docs/diagrams/icons/*.png, rasterized from the aws-icons
 * set) for AWS services, and labeled boxes for non-AWS/third-party elements
 * (open5gs, UERANSIM, Prometheus agent). Follows the guidance-architecture-diagram
 * template: title+description over a separator, grey right panel with numbered
 * callouts (bold AWS names, acronyms spelled out), AWS Cloud>Region grouping,
 * straight/right-angle 1.25pt open arrows, Arial, footer.
 *
 * Run: node docs/diagrams/generate-guidance-pptx.cjs <out.pptx>
 */
const path = require('path');
const pptxgen = require('/opt/homebrew/lib/node_modules/pptxgenjs');
const out = process.argv[2] || '5g-rcf-architecture-guidance.pptx';
const IC = (n) => path.join(__dirname, 'icons', n + '.png');
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
const S = pptx.ShapeType;
const slide = pptx.addSlide();

const DARK='232F3E', ORANGE='FF9900', BLUE='0972D3', GREEN='1B8B1B', PURPLE='7C3AED',
      RED='D13212', GRAY='666666', WHITE='FFFFFF',
      GREENBG='DCEEDC', ORANGEBG='FFE9CC', GREYBG='F5F5F5';
const F='Arial';

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

function labelBox(x,y,w,h,label,bg,border,fs){
  slide.addText(label, { x, y, w, h, fontSize:fs||8, bold:true, fontFace:F, color:DARK, align:'center',
    valign:'middle', fill:{color:bg}, line:{color:border, width:1} });
}
function svc(x,y,w,icon,label,fs){ // official AWS icon (centered) + label below
  const iw=0.5;
  slide.addImage({ path:IC(icon), x:x+(w-iw)/2, y, w:iw, h:iw });
  slide.addText(label, { x, y:y+iw+0.01, w, h:0.4, fontSize:fs||8, fontFace:F, color:DARK, align:'center', valign:'top' });
}
function callout(x,y,n){
  slide.addText(String(n), { x, y, w:0.24, h:0.24, fontSize:8.5, bold:true, fontFace:F, color:WHITE,
    fill:{color:ORANGE}, align:'center', valign:'middle', shape:S.ellipse });
}
function seg(x,y,w,h,color,head){
  slide.addShape(S.line, { x, y, w, h, line:{ color:color||GRAY, width:1.25,
    ...(head==='end'?{endArrowType:'triangle'}:{}), ...(head==='begin'?{beginArrowType:'triangle'}:{}) } });
}

// Amazon EKS group (icon at top-left) + non-AWS inner boxes
slide.addShape(S.rect, { x:0.7, y:1.5, w:3.05, h:2.95, fill:{type:'solid',color:'EAF3FB',transparency:35}, line:{color:ORANGE, width:1} });
slide.addImage({ path:IC('AmazonElasticKubernetesService'), x:0.78, y:1.55, w:0.32, h:0.32 });
slide.addText('Amazon EKS · open5gs-amp-cluster', { x:1.14, y:1.57, w:2.5, h:0.3, fontSize:8, bold:true, fontFace:F, color:DARK, valign:'middle' });
labelBox(0.85,2.0,2.75,0.5,'UERANSIM RAN — 100 gNodeBs · 1,000 UEs', WHITE, GRAY, 8);
labelBox(0.85,2.6,2.75,0.75,'open5gs 5G Core\nAMF · SMF · 4x UPF · NRF/UDM/PCF', WHITE, GRAY, 8);
labelBox(0.85,3.5,2.75,0.7,'Prometheus agent (ADOT)\nscrape + remote_write (SigV4)', GREENBG, GREEN, 8);
callout(0.56,1.7,1);

// Amazon Managed Service for Prometheus (+ RCF sub-note)
svc(4.05,1.5,2.5,'AmazonManagedServiceforPrometheus','Amazon Managed Service\nfor Prometheus',8);
labelBox(4.35,2.55,1.9,0.5,'RCF anomaly detector — score > 0.1 · 30s', GREENBG, GREEN, 7.5);
callout(4.05,1.56,2); callout(6.0,1.56,3);

// Amazon SNS
svc(6.75,1.5,1.9,'AmazonSimpleNotificationService','Amazon SNS\nRCA trigger topic',8);
callout(6.6,1.56,4);

// RCA AWS Lambda
svc(6.75,3.0,1.9,'AWSLambda','AWS Lambda\nRoot-cause analysis',8);
callout(6.6,3.06,5); callout(6.3,2.95,6);

// AWS Secrets Manager
svc(4.15,3.55,1.9,'AWSSecretsManager','AWS Secrets Manager\nagent webhook url+token',8);
callout(5.75,3.5,7);

// AWS DevOps Agent
svc(6.75,4.45,1.9,'AWSDevOpsAgent','AWS DevOps Agent\nautonomous investigation',8);
callout(6.6,4.51,8);

// Amazon SageMaker (bottom-left)
svc(0.85,5.15,2.3,'AmazonSageMaker','Amazon SageMaker — Demo notebook',8);
callout(0.66,5.18,9);

// Prometheus MCP group (bottom-right)
slide.addShape(S.rect, { x:5.35, y:5.5, w:3.25, h:1.4, fill:{type:'solid',color:'F3EEFC',transparency:35}, line:{color:PURPLE, width:1} });
slide.addText('Prometheus MCP server (on-demand query)', { x:5.43, y:5.53, w:3.1, h:0.2, fontSize:8, bold:true, fontFace:F, color:DARK });
svc(5.4,5.78,1.0,'AmazonCognito','Amazon Cognito',7.5);
svc(6.5,5.78,1.05,'AmazonAPIGateway','Amazon API Gateway',7.5);
svc(7.6,5.78,0.95,'AWSLambda','AWS Lambda',7.5);

// Arrows
seg(3.75,1.9,0.3,0,GREEN,'end');        // (2) EKS -> AMP
seg(6.55,1.9,0.2,0,GREEN,'end');        // (4) AMP -> SNS
seg(7.7,2.35,0,0.65,PURPLE,'end');      // (5) SNS -> Lambda
seg(6.4,3.2,0.35,0,BLUE,'begin');       // (6) Lambda -> AMP query
seg(6.05,3.75,0.7,0,RED,'end');         // (7) Secrets Manager -> Lambda
seg(7.7,3.9,0,0.55,PURPLE,'end');       // (8) Lambda -> DevOps Agent
seg(7.7,5.35,0,0.15,PURPLE,'end');      // DevOps Agent -> MCP
seg(6.25,3.2,0,2.3,BLUE,'begin');       // MCP -> AMP query
seg(3.35,5.5,0.55,0,BLUE,null);         // (9) SageMaker -> corridor
seg(3.9,1.95,0,3.55,BLUE,null);         // corridor up
seg(3.9,1.95,0.15,0,BLUE,'end');        // into AMP

// Footer
slide.addText('© 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.',
  { x:0.3, y:7.2, w:8.4, h:0.2, fontSize:6.5, fontFace:F, color:GRAY });

pptx.writeFile({ fileName: out }).then(()=>console.log('Wrote', out));
