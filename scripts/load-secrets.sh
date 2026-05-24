#!/bin/bash
# Loads secrets from macOS Keychain into environment variables
# Usage: source scripts/load-secrets.sh

SERVICE="grid"

export JWT_SECRET=$(security find-generic-password -a "JWT_SECRET" -s "$SERVICE" -w 2>/dev/null)
export JWT_REFRESH_SECRET=$(security find-generic-password -a "JWT_REFRESH_SECRET" -s "$SERVICE" -w 2>/dev/null)
export ANTHROPIC_API_KEY=$(security find-generic-password -a "ANTHROPIC_API_KEY" -s "$SERVICE" -w 2>/dev/null)
export ADMIN_PASSWORD=$(security find-generic-password -a "ADMIN_PASSWORD" -s "$SERVICE" -w 2>/dev/null)

if [ -z "$JWT_SECRET" ] || [ -z "$ANTHROPIC_API_KEY" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: One or more secrets missing from Keychain. Run: security add-generic-password -a KEY -s grid -w VALUE"
  exit 1
fi

echo "Secrets loaded from Keychain"
