import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import { Construct } from 'constructs';

/**
 * Amazon Managed Prometheus (AMP) workspace — the metric store that open5gs
 * remote-writes to and the Prometheus MCP Lambda queries. The aws-samples MCP
 * CDK does NOT create AMP; this stack fills that gap so the package is complete.
 */
export class AmpStack extends cdk.Stack {
  public readonly workspaceId: string;
  public readonly workspaceArn: string;
  public readonly prometheusUrl: string;       // query endpoint (no trailing /api/v1)
  public readonly remoteWriteUrl: string;      // remote_write endpoint

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ws = new aps.CfnWorkspace(this, 'Open5gsAmp', {
      alias: 'open5gs-amp',
    });

    this.workspaceId = ws.attrWorkspaceId;
    this.workspaceArn = ws.attrArn;
    // https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>
    this.prometheusUrl = `https://aps-workspaces.${this.region}.amazonaws.com/workspaces/${ws.attrWorkspaceId}`;
    this.remoteWriteUrl = `${this.prometheusUrl}/api/v1/remote_write`;

    new cdk.CfnOutput(this, 'WorkspaceId', { value: this.workspaceId });
    new cdk.CfnOutput(this, 'WorkspaceArn', { value: this.workspaceArn });
    new cdk.CfnOutput(this, 'PrometheusQueryUrl', { value: this.prometheusUrl });
    new cdk.CfnOutput(this, 'RemoteWriteUrl', { value: this.remoteWriteUrl });
  }
}
