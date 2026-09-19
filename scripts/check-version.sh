#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, re, sys

info = json.load(open("Info.json"))
version = str(info.get("version") or "")
gh_version = info.get("ghVersion")
simkl = open("simkl.js").read()
intro = open("introdb.js").read()
plugin = re.search(r'PLUGIN_VERSION = "([^"]+)"', simkl)
agent = re.search(r'USER_AGENT = "iina-simkl-scrobbler/([^"]+)"', intro)
errors = []
if not version:
    errors.append("Info.json version is missing")
if not isinstance(gh_version, int) or gh_version < 1:
    errors.append("Info.json ghVersion must be a positive integer")
if not plugin:
    errors.append("simkl.js PLUGIN_VERSION is missing")
elif plugin.group(1) != version:
    errors.append("simkl.js PLUGIN_VERSION %s != Info.json %s" % (plugin.group(1), version))
if not agent:
    errors.append("introdb.js USER_AGENT version is missing")
elif agent.group(1) != version:
    errors.append("introdb.js USER_AGENT %s != Info.json %s" % (agent.group(1), version))
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("version %s  ghVersion %s" % (version, gh_version))
PY
