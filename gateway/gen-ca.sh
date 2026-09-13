#!/usr/bin/env bash
# Generate a LOCAL CA and a leaf cert for api.anthropic.com, used only by the
# local pinning probe on this machine. The CA is never added to the system trust
# store; it is passed to Claude Code for one run via NODE_EXTRA_CA_CERTS.
#
# You are running this yourself, deliberately, to intercept your OWN authenticated
# traffic for building your own harness extension. Delete gateway/ca/ when done.
set -euo pipefail
cd "$(dirname "$0")/ca"

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 \
  -subj "/CN=SoL-ClaudeCode Local Probe CA" -addext "basicConstraints=critical,CA:TRUE"

openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr \
  -subj "/CN=api.anthropic.com" -addext "subjectAltName=DNS:api.anthropic.com"

openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem \
  -days 825 -copy_extensions=copyall

echo "=== generated ==="
ls -la .
echo "=== leaf SAN ==="
openssl x509 -in leaf.pem -noout -ext subjectAltName
