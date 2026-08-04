Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

**********************
THIRD PARTY COMPONENTS
**********************

This Guidance's own code (AWS CDK application, deployment scripts, Kubernetes manifests,
and the demo notebook) is licensed under the MIT-0 License — see `LICENSE`.

This Guidance **deploys**, but does not redistribute or statically link, the third-party
software below. The container images are pulled at deployment time from their respective
registries into the customer's own Amazon EKS cluster. No third-party source code is
incorporated into or distributed with this repository.

--------------------------------------------------------------------------------
5G core and radio access network simulation
--------------------------------------------------------------------------------

Open5GS
© Sukchan Lee and the Open5GS contributors
GNU Affero General Public License v3.0 (AGPL-3.0)
https://github.com/open5gs/open5gs — https://open5gs.org/open5gs/support/
Deployed as a container image (open5gs 2.6.6). A commercial license is available from
the Open5GS project for use cases where AGPL-3.0 compliance is not feasible.

UERANSIM
© ALİ GÜNGÖR
Dual licensed: GNU Affero General Public License v3.0 (AGPL-3.0) and a commercial license
https://github.com/aligungr/UERANSIM
Deployed as a container image (gradiant/ueransim 3.2.6). Note the project's own guidance:
closed-source commercial usage may not be permitted under AGPL-3.0; contact the maintainer
for a commercial license if required.

--------------------------------------------------------------------------------
Observability
--------------------------------------------------------------------------------

kube-prometheus-stack (Helm chart) and Prometheus
© The Prometheus Authors / prometheus-community
Apache License 2.0
https://github.com/prometheus-community/helm-charts — https://github.com/prometheus/prometheus

--------------------------------------------------------------------------------
Data store used by the 5G core
--------------------------------------------------------------------------------

MongoDB Community Server
© MongoDB, Inc.
Server Side Public License (SSPL) v1
https://www.mongodb.com/legal/licensing/server-side-public-license
Deployed as a container image (mongo 6.0) as the Open5GS subscriber database.

--------------------------------------------------------------------------------
Bundled Python dependencies (AWS Lambda deployment packages)
--------------------------------------------------------------------------------

cryptography — © The Python Cryptographic Authority and individual contributors
  Apache License 2.0 OR BSD 3-Clause — https://github.com/pyca/cryptography
cffi — © Armin Rigo, Maciej Fijalkowski — MIT License — https://github.com/python-cffi/cffi
pycparser — © Eli Bendersky — BSD 3-Clause — https://github.com/eliben/pycparser
PyJWT — © José Padilla — MIT License — https://github.com/jpadilla/pyjwt

--------------------------------------------------------------------------------
Derived AWS sample code
--------------------------------------------------------------------------------

Prometheus MCP server (Amazon Managed Service for Prometheus MCP)
© Amazon.com, Inc. or its affiliates
Apache License 2.0
https://github.com/awslabs/mcp
The Lambda/API Gateway/Amazon Cognito MCP wrapper in `cdk/` is derived from the awslabs
Model Context Protocol sample for Amazon Managed Service for Prometheus.

--------------------------------------------------------------------------------
Notes for reviewers
--------------------------------------------------------------------------------

* Open5GS, UERANSIM (AGPL-3.0) and MongoDB Community (SSPL) are copyleft / source-available
  licenses. They are used here **unmodified**, as demonstration workloads that generate the
  telemetry this Guidance analyses. They are not required by the Guidance pattern itself —
  the Amazon Managed Service for Prometheus anomaly detection, alert forwarding, and AWS
  DevOps Agent integration work with any Prometheus-compatible metric source.
* The Open5GS and MongoDB images referenced in `manifests/` are hosted on a public
  Amazon ECR Public registry that is not operated by the upstream projects. Customers who
  require a verified supply chain should build these images from upstream source, or mirror
  them into their own registry, before production use.
