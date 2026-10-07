#!/bin/sh
set -eu

data_dir=/app/var
rules_dir="$data_dir/review-rules"
claude_home="${HOME:-$data_dir}"
claude_config_dir="${CLAUDE_CONFIG_DIR:-$claude_home/.config/claude}"

# Review workspaces are ephemeral: a review owns its workspace only for the
# lifetime of the execution, and service shutdown cancels in-flight reviews.
# Remove leftovers from an ungraceful restart before the persistent hostPath is
# reused; otherwise abandoned shallow clones can fill the deployment node and
# prevent the next review from creating its workspace.
if [ -d "$data_dir/review-workspaces" ]; then
  find "$data_dir/review-workspaces" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi

mkdir -p "$rules_dir" "$data_dir/review-workspaces" "$claude_config_dir"

# Keep Claude Code non-interactive in a fresh PVC. Credentials and model
# settings are initialized into the application database and can be edited
# from the model settings page.
if [ ! -f "$claude_config_dir/config.json" ]; then
  printf '%s\n' '{"includeCoAuthoredBy":false}' > "$claude_config_dir/config.json"
fi

if [ ! -f "$claude_home/.claude.json" ]; then
  printf '%s\n' '{"hasCompletedOnboarding":true,"projects":{}}' > "$claude_home/.claude.json"
fi

if [ ! -f "$data_dir/review-profiles.json" ]; then
  cp /app/config/review-profiles.json "$data_dir/review-profiles.json"
fi

if [ ! -f "$data_dir/inspection-profiles.json" ]; then
  cp /app/config/inspection-profiles.json "$data_dir/inspection-profiles.json"
fi

# Seed new default rules without overwriting rules edited through the UI.
cp -a -n /app/config/skills/. "$rules_dir/"

exec "$@"
