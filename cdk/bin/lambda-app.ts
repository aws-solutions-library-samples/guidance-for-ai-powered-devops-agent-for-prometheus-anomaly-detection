#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AmpStack } from '../lib/amp-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { APIGatewayLambdaStack } from '../lib/api-gateway-lambda-stack';
import { NotebookStack } from '../lib/notebook-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' };

// 1) Amazon Managed Prometheus workspace + RCF anomaly detector + alert rules
const amp = new AmpStack(app, 'Open5gsAmpStack', { env, description: 'Amazon Managed Prometheus workspace for open5gs' });

// 2) Cognito M2M OAuth2 (inbound auth for the MCP)
const cognito = new CognitoStack(app, 'PrometheusLambdaMCPCognitoStack', { env, description: 'Cognito User Pool + OAuth for Prometheus MCP' });

// 3) Prometheus MCP Lambda — queries the AMP workspace
const lambdaStack = new LambdaStack(app, 'PrometheusLambdaMCPStack', {
  env,
  description: 'Prometheus MCP Lambda (queries AMP)',
  prometheusUrl: amp.prometheusUrl,
});
lambdaStack.addDependency(amp);

// 4) API Gateway with JWT authorizer fronting the MCP Lambda
const apiGatewayStack = new APIGatewayLambdaStack(app, 'PrometheusLambdaMCPAPIGatewayStack', {
  env,
  description: 'API Gateway (JWT) for the Prometheus MCP Lambda',
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
  description: 'SageMaker Notebook for RCF anomaly detection demo',
  workspaceId: amp.workspaceId,
});
notebookStack.addDependency(amp);

// Agent registration (DevOps Agent capability provider, register-only, OAuth2) is done by
// deploy/20-register-agent.sh using these stacks' outputs (keeps the Cognito client secret
// out of CDK/LLM context). It NEVER creates an Agent Space.
app.synth();
