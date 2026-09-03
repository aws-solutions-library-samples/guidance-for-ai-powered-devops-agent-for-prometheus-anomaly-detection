#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AmpStack } from '../lib/amp-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { APIGatewayLambdaStack } from '../lib/api-gateway-lambda-stack';
import { NotebookStack } from '../lib/notebook-stack';

const app = new cdk.App();
// cdk-nag: runs the AWS Solutions security ruleset on every synth. Findings show up in
// synth output; suppress with NagSuppressions where a rule is intentionally not applicable.
cdk.Aspects.of(app).add(new AwsSolutionsChecks());
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' };

// 1) Amazon Managed Prometheus workspace + RCF anomaly detector + alert rules
const amp = new AmpStack(app, 'Open5gsAmpStack', { env, description: '(SO9724) Amazon Managed Prometheus workspace for open5gs' });

// 2) Cognito M2M OAuth2 (inbound auth for the MCP)
const cognito = new CognitoStack(app, 'PrometheusLambdaMCPCognitoStack', { env, description: '(SO9724) Cognito User Pool + OAuth for Prometheus MCP' });

// 3) Prometheus MCP Lambda — queries the AMP workspace
const lambdaStack = new LambdaStack(app, 'PrometheusLambdaMCPStack', {
  env,
  description: '(SO9724) Prometheus MCP Lambda (queries AMP)',
  prometheusUrl: amp.prometheusUrl,
});
lambdaStack.addDependency(amp);

// 4) API Gateway with JWT authorizer fronting the MCP Lambda
const apiGatewayStack = new APIGatewayLambdaStack(app, 'PrometheusLambdaMCPAPIGatewayStack', {
  env,
  description: '(SO9724) API Gateway (JWT) for the Prometheus MCP Lambda',
  mcpFunction: lambdaStack.mcpFunction,
  userPool: cognito.userPool,
  m2mClient: cognito.m2mClient,
  cognitoDomain: cognito.userPoolDomain,
});
apiGatewayStack.addDependency(cognito);
apiGatewayStack.addDependency(lambdaStack);

// 5) SageMaker Notebook with RCF demo notebook pre-loaded
const notebookStack = new NotebookStack(app, 'Open5gsNotebookStack', {
  env,
  description: '(SO9724) SageMaker Notebook for RCF anomaly detection demo',
});
notebookStack.addDependency(amp);

// ─── cdk-nag suppressions (all with written justification) ───────────────────────────
// See docs/security/README.md for the full Security Matrix. Kept centrally so a reviewer
// can audit every accepted risk in one place.

// AWSLambdaBasicExecutionRole is the AWS-managed policy that Lambda uses to write logs
// to CloudWatch. It is the standard, minimal grant for Lambda functions; replacing it
// with an inline copy adds noise without changing effective permissions.
NagSuppressions.addStackSuppressions(amp, [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for CloudWatch Logs write access; equivalent to hand-rolling logs:CreateLogGroup/CreateLogStream/PutLogEvents.',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
  { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the latest generally-available Lambda runtime for this ruleset (3.13 not yet available in all regions at time of writing).' },
  { id: 'AwsSolutions-SMG4', reason: 'Rotation is not applicable: the DevOps Agent webhook secret holds an out-of-band token the operator generates in the Agent Space console. Rotating server-side without the operator regenerating the webhook would break the pipeline.' },
]);
NagSuppressions.addStackSuppressions(lambdaStack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for CloudWatch Logs; equivalent to a hand-rolled copy.',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcards on aps:QueryMetrics/ListSeries/GetLabels/GetMetricMetadata are scoped to the AMP workspace ARN; resource-level ARNs for query-time actions on APS are Resource:*, matching AWS documented usage.',
    appliesTo: ['Resource::*'] },
  { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the latest generally-available Lambda runtime for this ruleset.' },
]);
NagSuppressions.addStackSuppressions(cognito, [
  { id: 'AwsSolutions-COG2', reason: 'MFA does not apply to a machine-to-machine OAuth2 client-credentials flow. No user pool users exist; the m2m client authenticates via client_id + client_secret.' },
  { id: 'AwsSolutions-COG8', reason: 'The user pool has no human users and no advanced security features (compromised-credentials detection, adaptive auth) are required for the M2M flow. Plus tier adds per-MAU cost without a security benefit here.' },
]);
NagSuppressions.addStackSuppressions(apiGatewayStack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWS-managed policies used are the standard service-role policies for their respective purposes: AWSLambdaBasicExecutionRole for CloudWatch Logs, AmazonAPIGatewayPushToCloudWatchLogs for the account-level API Gateway logging role. Both are documented AWS-recommended patterns; hand-rolling copies adds no security value.',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'] },
  { id: 'AwsSolutions-IAM5', reason: 'Autogenerated CDK role for API Gateway push-to-CloudWatch-logs permissions uses managed policy AmazonAPIGatewayPushToCloudWatchLogs. This is the CDK-recommended setup for account-level logging role.',
    appliesTo: ['Resource::*'] },
  { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the latest generally-available Lambda runtime for this ruleset.' },
  { id: 'AwsSolutions-APIG2', reason: 'Request validation is not applicable to the JSON-RPC 2.0 MCP protocol on /mcp — the JWT authorizer validates identity, and the MCP Lambda itself validates the JSON-RPC envelope + method + params before dispatch.' },
  { id: 'AwsSolutions-APIG3', reason: 'WAFv2 is not required for the machine-to-machine MCP endpoint: it is JWT-authorized (Cognito) and only reachable by holders of the shared m2m client_secret. WAF adds no defense against an authenticated attacker.' },
  { id: 'AwsSolutions-APIG4', reason: 'GET /health is intentionally public and returns only static "healthy" status with no data. It is used by the DevOps Agent capability-provider registration to confirm reachability before the OAuth handshake.' },
  { id: 'AwsSolutions-COG4', reason: 'POST /mcp is authorized by a custom Lambda TokenAuthorizer that validates Cognito JWTs (cdk-nag does not recognize custom authorizers as equivalent). /health is intentionally public.' },
]);
NagSuppressions.addStackSuppressions(notebookStack, [
  { id: 'AwsSolutions-IAM4', reason: 'AmazonSageMakerFullAccess is the standard managed policy required for a SageMaker Notebook Instance to operate. Replacing it with equivalent inline policies would be a paste of ~150 lines with no security delta.',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSageMakerFullAccess',
                'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
  { id: 'AwsSolutions-IAM5', reason: 'S3 GetObject/ListBucket use bucket-ARN + bucket-ARN/* patterns; aps:List/Describe on the AMP service require Resource:* per AWS docs. The Secrets Manager wildcard is the standard CFN pattern for referencing a secret by name (secret ARNs get a 6-char random suffix, so open5gs/devops-agent/webhook-* is the tightest scope achievable).' },
  { id: 'AwsSolutions-S1', reason: 'Server access logs are not enabled on the notebook-content bucket. Contents are regenerated from CDK (the notebook file) on every deploy and are non-sensitive (public architecture diagrams + demo notebook code). Log storage cost is not justified.' },
  { id: 'AwsSolutions-SM1', reason: 'The notebook is intentionally deployed public in deploy/10 (before EKS exists) so the demo runs even if VPC-attach is skipped. deploy/60 then destroys+recreates the notebook VPC-attached to the EKS private subnet, at which point SM1/SM3 are naturally satisfied. Both states are documented and controlled by CDK context (eksVpcId/eksSubnetId/eksClusterSg).' },
  { id: 'AwsSolutions-SM3', reason: 'Direct internet is required while the notebook is running without VPC attachment so pip/kubectl can reach public endpoints during Setup. deploy/60 flips this off by attaching to a private VPC subnet (directInternetAccess=Disabled) once EKS exists.' },
  // CDK-autogenerated custom resource that uploads files to S3 (BucketDeployment).
  // Its Lambda has wildcards on the CDK-assets S3 bucket because BucketDeployment needs to
  // fetch, upload, and delete objects; this is standard CDK behavior for BucketDeployment.
  { id: 'AwsSolutions-L1', reason: 'CDK-autogenerated Lambda (Custom::CDKBucketDeployment) — runtime is set by the CDK library; we cannot override it from our stack.' },
  { id: 'AwsSolutions-IAM5', reason: 'CDK-autogenerated permissions on BucketDeployment need s3:GetBucket*, s3:GetObject*, s3:List*, s3:Abort*, s3:DeleteObject* on the CDK-assets bucket to upload / clean up the notebook zip. This is stock CDK behavior for BucketDeployment.' },
]);
// ─────────────────────────────────────────────────────────────────────────────────────

// Agent registration (DevOps Agent capability provider, register-only, OAuth2) is done by
// deploy/20-register-agent.sh using these stacks' outputs (keeps the Cognito client secret
// out of CDK/LLM context). It NEVER creates an Agent Space.
app.synth();
