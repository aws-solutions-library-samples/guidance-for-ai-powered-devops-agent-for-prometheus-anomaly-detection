import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * SageMaker Notebook instance pre-loaded with the RCF anomaly detection demo notebook.
 * Access via AWS Console → SageMaker → Notebook instances → Open Jupyter.
 * The notebook self-discovers the AMP workspace by alias at runtime, so no workspace
 * ID is injected here.
 */
export class NotebookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for notebook files. Explicit BLOCK_ALL — required for burner accounts,
    // which auto-close on any public S3 bucket. Also enforces TLS at rest.
    const bucket = new s3.Bucket(this, 'NotebookBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // Upload notebook to S3
    new s3deploy.BucketDeployment(this, 'DeployNotebook', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'notebook'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'notebooks',
    });

    // IAM role for the notebook instance
    const role = new iam.Role(this, 'NotebookRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
      inlinePolicies: {
        AmpReadOnly: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'aps:QueryMetrics',
                'aps:GetMetricMetadata',
                'aps:GetSeries',
                'aps:GetLabels',
                'aps:DescribeAnomalyDetector',
                'aps:ListAnomalyDetectors',
                'aps:DescribeRuleGroupsNamespace',
                'aps:ListRuleGroupsNamespaces',
                'aps:ListWorkspaces',
                'aps:DescribeWorkspace',
              ],
              resources: ['*'],
            }),
          ],
        }),
        EksReadOnly: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['eks:DescribeCluster', 'eks:ListClusters'],
              resources: ['*'],
            }),
          ],
        }),
        S3NotebookAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
            }),
          ],
        }),
        DevOpsAgentWebhookSecret: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Lets the demo notebook's "wire the DevOps Agent" cell store the webhook
              // URL + secret so the forwarder Lambda posts incidents. Scoped to that one secret.
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:PutSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:open5gs/devops-agent/webhook-*`,
              ],
            }),
          ],
        }),
      },
    });

    // Lifecycle config:
    //  - onCreate: install kubectl + pull notebook from S3 (first boot)
    //  - onStart:  re-pull latest notebook from S3 every start (Stop/Start refreshes it)
    const onCreateScript = cdk.Fn.base64(`#!/bin/bash
set -e
BUCKET="${bucket.bucketName}"

# Install kubectl
curl -sLO "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl"
chmod +x kubectl && mv kubectl /usr/local/bin/

# Copy notebook files from S3
aws s3 cp s3://$BUCKET/notebooks/ /home/ec2-user/SageMaker/ --recursive
chown -R ec2-user:ec2-user /home/ec2-user/SageMaker/
`);

    const onStartScript = cdk.Fn.base64(`#!/bin/bash
set -e
BUCKET="${bucket.bucketName}"

# Ensure kubectl is present (in case of AMI changes)
if [ ! -f /usr/local/bin/kubectl ]; then
  curl -sLO "https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl"
  chmod +x kubectl && mv kubectl /usr/local/bin/
fi

# Always pull the LATEST notebook from S3 on start (refreshes after updates)
aws s3 cp s3://$BUCKET/notebooks/ /home/ec2-user/SageMaker/ --recursive
chown -R ec2-user:ec2-user /home/ec2-user/SageMaker/
`);

    const lifecycleConfig = new sagemaker.CfnNotebookInstanceLifecycleConfig(this, 'LifecycleConfig', {
      notebookInstanceLifecycleConfigName: 'open5gs-rcf-demo-lcc',
      onCreate: [{ content: onCreateScript }],
      onStart: [{ content: onStartScript }],
    });

    // Two-step recreate helper: `-c skipNotebook=true` omits the notebook instance so a
    // networking change (which forces replacement of this custom-named resource) can be
    // applied as delete-then-create across two deploys, preserving the fixed name.
    const skipNotebook = this.node.tryGetContext('skipNotebook') === 'true';

    // Optional VPC attach so the notebook uses the EKS PRIVATE endpoint (removes the
    // publicAccessCidrs dependency and works in any account/region). Values are resolved
    // from the cluster by deploy/60 and passed via context; when absent the notebook stays
    // public (kubectl cells then depend on the public endpoint allowlist).
    if (!skipNotebook) {
    const eksVpcId = (this.node.tryGetContext('eksVpcId') as string) || '';
    const eksSubnetId = (this.node.tryGetContext('eksSubnetId') as string) || '';
    const eksClusterSg = (this.node.tryGetContext('eksClusterSg') as string) || '';
    const vpcAttach = !!(eksVpcId && eksSubnetId && eksClusterSg);
    let vpcProps: Partial<sagemaker.CfnNotebookInstanceProps> = {};
    if (vpcAttach) {
      const nbSg = new ec2.CfnSecurityGroup(this, 'NotebookSg', {
        vpcId: eksVpcId,
        groupDescription: 'SageMaker RCF notebook to EKS private API endpoint plus NAT egress',
        securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      });
      // Allow the notebook SG to reach the EKS API (443) on the cluster security group.
      new ec2.CfnSecurityGroupIngress(this, 'ClusterApiFromNotebook', {
        groupId: eksClusterSg, ipProtocol: 'tcp', fromPort: 443, toPort: 443,
        sourceSecurityGroupId: nbSg.ref, description: 'SageMaker RCF notebook to EKS API',
      });
      // Private subnet (with NAT) => private EKS endpoint access + internet for pip/kubectl.
      vpcProps = { subnetId: eksSubnetId, securityGroupIds: [nbSg.ref], directInternetAccess: 'Disabled' };
    }

    // SageMaker Notebook Instance (VPC-attached when context is provided)
    // kmsKeyId: use the account's default AWS-managed KMS key for EBS. cdk-nag SM2
    // requires an explicit key; AWS-managed alias 'aws/sagemaker' is created on demand.
    const kmsAlias = 'alias/aws/sagemaker';
    const notebook = new sagemaker.CfnNotebookInstance(this, 'DemoNotebook', {
      instanceType: 'ml.t3.medium',
      roleArn: role.roleArn,
      notebookInstanceName: 'open5gs-rcf-anomaly-demo',
      lifecycleConfigName: lifecycleConfig.attrNotebookInstanceLifecycleConfigName,
      volumeSizeInGb: 10,
      kmsKeyId: kmsAlias,
      ...vpcProps,
    });
    notebook.addDependency(lifecycleConfig);
    new cdk.CfnOutput(this, 'NotebookVpcAttached', {
      value: vpcAttach ? `yes (private endpoint via ${eksSubnetId})` : 'no (public endpoint)',
    });

    // Outputs
    new cdk.CfnOutput(this, 'NotebookUrl', {
      value: `https://${this.region}.console.aws.amazon.com/sagemaker/home?region=${this.region}#/notebook-instances/open5gs-rcf-anomaly-demo`,
      description: 'Open SageMaker Notebook in AWS Console (click "Open Jupyter")',
    });
    new cdk.CfnOutput(this, 'NotebookName', { value: 'open5gs-rcf-anomaly-demo' });
    }
  }
}
