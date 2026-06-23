import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import { Construct } from 'constructs';

/**
 * Amazon Managed Prometheus (AMP) workspace + RCF anomaly detection.
 *
 * Resources:
 * - AMP Workspace (metric store for open5gs remote_write + MCP Lambda queries)
 * - RCF Anomaly Detector on sum(fivegs_amffunction_rm_registeredsubnbr)
 * - Alert rule: fires when RCF score > 0.1 (onset detection, for: 0s)
 */
export class AmpStack extends cdk.Stack {
  public readonly workspaceId: string;
  public readonly workspaceArn: string;
  public readonly prometheusUrl: string;
  public readonly remoteWriteUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── AMP Workspace ───
    const ws = new aps.CfnWorkspace(this, 'Open5gsAmp', {
      alias: 'open5gs-amp',
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

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'WorkspaceId', { value: this.workspaceId });
    new cdk.CfnOutput(this, 'WorkspaceArn', { value: this.workspaceArn });
    new cdk.CfnOutput(this, 'PrometheusQueryUrl', { value: this.prometheusUrl });
    new cdk.CfnOutput(this, 'RemoteWriteUrl', { value: this.remoteWriteUrl });
    new cdk.CfnOutput(this, 'RcfDetectorAlias', { value: '5g-registered-subscribers' });
  }
}
