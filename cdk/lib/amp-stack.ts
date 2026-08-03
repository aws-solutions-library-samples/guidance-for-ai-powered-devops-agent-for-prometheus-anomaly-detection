import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Amazon Managed Prometheus (AMP) workspace + RCF anomaly detection + automated RCA (scenario 2b).
 *
 * Resources:
 * - AMP Workspace (metric store for open5gs remote_write + MCP Lambda queries)
 *   with an Alertmanager definition that routes the RCF alert to SNS.
 * - RCF Anomaly Detector on sum(fivegs_amffunction_rm_registeredsubnbr)
 * - Alert rule: fires when RCF score > 0.1 (onset detection, for: 0s)
 * - Automated RCA pipeline (2b): SNS topic -> Lambda bridge that runs the RCA correlation
 *   (identifies which AMF dropped via AMP) and forwards an incident to the DevOps Agent
 *   webhook. The webhook {url,token} lives in a Secrets Manager secret that a human fills
 *   in AFTER creating the Agent Space (console or deploy/70-wire-agent-webhook.sh) — the
 *   real value never flows through CDK/CloudFormation.
 */
export class AmpStack extends cdk.Stack {
  public readonly workspaceId: string;
  public readonly workspaceArn: string;
  public readonly prometheusUrl: string;
  public readonly remoteWriteUrl: string;
  public readonly rcaTopicArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Automated-RCA config (2b) ───
    // Fixed SNS topic name so the workspace Alertmanager definition can reference a
    // deterministic ARN without creating a workspace->topic dependency cycle.
    const rcaTopicName = 'open5gs-rcf-rca-trigger';
    const rcaTopicArn = `arn:aws:sns:${this.region}:${this.account}:${rcaTopicName}`;
    // Optional env-var fallback: `cdk deploy -c devopsAgentWebhookUrl=https://...` (no auth token).
    // Preferred path is the Secrets Manager secret below (supports a token, no redeploy to rotate).
    const devopsAgentWebhookUrl = (this.node.tryGetContext('devopsAgentWebhookUrl') as string) || '';

    // Alertmanager config: route every firing alert (only RCF5GRegistrationDrop exists) to SNS.
    const alertManagerConfig = `alertmanager_config: |
  route:
    receiver: 'rca-sns'
    group_by: ['alertname']
    group_wait: 30s
    group_interval: 1m
    repeat_interval: 5m
  receivers:
    - name: 'rca-sns'
      sns_configs:
        - topic_arn: ${rcaTopicArn}
          sigv4:
            region: ${this.region}
          subject: 'RCF 5G registration anomaly'
          message: |
            {{ range .Alerts }}alertname={{ .Labels.alertname }} state={{ .Status }} alias={{ .Labels.alias }}
            {{ .Annotations.summary }}
            {{ end }}
`;

    // ─── AMP Workspace (+ Alertmanager routing to SNS) ───
    const ws = new aps.CfnWorkspace(this, 'Open5gsAmp', {
      alias: 'open5gs-amp',
      alertManagerDefinition: alertManagerConfig,
    });

    this.workspaceId = ws.attrWorkspaceId;
    this.workspaceArn = ws.attrArn;
    this.prometheusUrl = `https://aps-workspaces.${this.region}.amazonaws.com/workspaces/${ws.attrWorkspaceId}`;
    this.remoteWriteUrl = `${this.prometheusUrl}/api/v1/remote_write`;

    // ─── RCF Anomaly Detector: 5G Registered Subscribers ───
    const rcfDetector = new aps.CfnAnomalyDetector(this, 'RcfRegisteredSubscribers', {
      workspace: ws.attrArn,
      alias: '5g-registered-subscribers',
      evaluationIntervalInSeconds: 30,
      configuration: {
        randomCutForest: {
          query: 'sum(fivegs_amffunction_rm_registeredsubnbr)',
          shingleSize: 8,
          sampleSize: 256,
        },
      },
    });
    rcfDetector.addDependency(ws);

    // ─── Alert Rules: RCF Anomaly Detection ───
    const alertRulesYaml = `groups:
  - name: rcf-anomaly-alerts
    rules:
      - alert: RCF5GRegistrationDrop
        expr: anomaly_detector:score{alias="5g-registered-subscribers"} > 0.1
        for: 0s
        labels:
          severity: critical
          service: 5g-core
        annotations:
          summary: "RCF anomaly on 5G registrations"
          description: "Score {{ $value }}. Check AMF pods and recent config changes."
`;
    new aps.CfnRuleGroupsNamespace(this, 'RcfAlertRules', {
      workspace: ws.attrArn,
      name: 'rcf-anomaly-alerts',
      data: alertRulesYaml,
    });

    // ─── Automated RCA pipeline (2b): SNS topic -> Lambda bridge ───
    const rcaTopic = new sns.Topic(this, 'RcaTriggerTopic', {
      topicName: rcaTopicName,
      displayName: 'open5gs RCF RCA trigger',
    });
    this.rcaTopicArn = rcaTopic.topicArn;

    // Allow AMP (this workspace only) to publish alert notifications to the topic.
    rcaTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAMPPublish',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('aps.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [rcaTopic.topicArn],
      conditions: {
        ArnEquals: { 'aws:SourceArn': ws.attrArn },
        StringEquals: { 'aws:SourceAccount': this.account },
      },
    }));

    // Secrets Manager secret holding the DevOps Agent Space webhook {url, token}.
    // Created as an empty placeholder; a human fills it in AFTER creating the Agent Space
    // (Secrets Manager console or deploy/70-wire-agent-webhook.sh). The real value never
    // flows through CDK/CloudFormation, and rotating it needs no redeploy.
    const agentSecret = new secretsmanager.Secret(this, 'AgentWebhookSecret', {
      secretName: 'open5gs/devops-agent/webhook',
      description: 'DevOps Agent Space webhook url+token; filled in post-deploy via deploy/70-wire-agent-webhook.sh',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({ url: '', token: '' })),
    });

    // RCA bridge Lambda (dependency-free: bundled botocore SigV4 + urllib).
    const rcaFn = new lambda.Function(this, 'RcaBridge', {
      functionName: 'open5gs-rcf-rca',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-rca')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Runs RCA on the RCF alert and forwards to the DevOps Agent webhook (from Secrets Manager)',
      environment: {
        AMP_WORKSPACE_ID: ws.attrWorkspaceId,
        AGENT_WEBHOOK_SECRET_ARN: agentSecret.secretArn,
        DEVOPS_AGENT_WEBHOOK_URL: devopsAgentWebhookUrl,
      },
    });

    // Least-privilege: query only this AMP workspace.
    rcaFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'],
      resources: [ws.attrArn],
    }));

    // Let the Lambda read the webhook secret at runtime (adds GetSecretValue + KMS decrypt).
    agentSecret.grantRead(rcaFn);

    // SNS -> Lambda (LambdaSubscription adds the invoke permission automatically).
    rcaTopic.addSubscription(new subscriptions.LambdaSubscription(rcaFn));

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'WorkspaceId', { value: this.workspaceId });
    new cdk.CfnOutput(this, 'WorkspaceArn', { value: this.workspaceArn });
    new cdk.CfnOutput(this, 'PrometheusQueryUrl', { value: this.prometheusUrl });
    new cdk.CfnOutput(this, 'RemoteWriteUrl', { value: this.remoteWriteUrl });
    new cdk.CfnOutput(this, 'RcfDetectorAlias', { value: '5g-registered-subscribers' });
    new cdk.CfnOutput(this, 'RcaTopicArn', { value: rcaTopic.topicArn });
    new cdk.CfnOutput(this, 'RcaLambdaName', { value: rcaFn.functionName });
    new cdk.CfnOutput(this, 'AgentWebhookSecretName', { value: agentSecret.secretName });
    new cdk.CfnOutput(this, 'DevopsAgentWebhook', {
      value: 'fill via deploy/70-wire-agent-webhook.sh (Secrets Manager: open5gs/devops-agent/webhook)',
    });
  }
}
