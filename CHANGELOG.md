# Change Log
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-04
### Added
- Amazon Managed Service for Prometheus workspace with a Random Cut Forest (RCF) anomaly
  detector on the 5G registered-subscriber count, plus the `RCF5GRegistrationDrop` alert rule.
- Alert forwarding pipeline: Alertmanager to Amazon SNS to an AWS Lambda forwarder that posts
  the incident to an AWS DevOps Agent webhook (HMAC or API key auth, credentials read from
  AWS Secrets Manager at runtime).
- OAuth2-secured Prometheus MCP server (AWS Lambda, Amazon API Gateway, Amazon Cognito) so the
  AWS DevOps Agent can query metrics during an investigation.
- Amazon EKS deployment of the Open5GS 5G core and UERANSIM RAN (100 gNodeBs, 1,000 UEs) with a
  Prometheus agent remote-writing to Amazon Managed Service for Prometheus over SigV4 and IRSA.
- Amazon SageMaker demo notebook covering baseline, agent wiring, fault injection, anomaly
  observation, automated investigation, and recovery.
- Reference architecture diagram in the AWS Guidance template format.
