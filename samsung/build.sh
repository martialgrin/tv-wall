#!/bin/bash
# NOT USED: the wall now plays on Raspberry Pis (README, section 3). Kept for reference.
#
# Build and sign the TV Wall app for Samsung signage displays, as samsung/TVWall.wgt.
# The server then offers it to the displays at http://<mac>:3000/samsung (URL Launcher).
# Needs Samsung's tizen command line tool and a Samsung certificate profile: see README.
#
# Usage:  ./samsung/build.sh <certificate profile> [server address]
#   e.g.  ./samsung/build.sh tvwall 192.168.0.10:3000
# Set TIZEN=/path/to/tizen if the tool is not found.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
profile="${1:-}"
server="${2:-192.168.0.10:3000}"
if [ -z "$profile" ]; then
  echo "Usage: ./samsung/build.sh <certificate profile> [server address]"
  exit 1
fi

tizen_cli="${TIZEN:-$(command -v tizen || true)}"
for candidate in "$HOME/tizen-studio/tools/ide/bin/tizen" "$HOME/tizen-studio/tools/ide/bin/tizen.sh"; do
  if [ -z "$tizen_cli" ] && [ -x "$candidate" ]; then tizen_cli="$candidate"; fi
done
if [ -z "$tizen_cli" ]; then
  # VS Code's Tizen Extension ("Tizen: Install Tizen CLI") puts the tool in one of these folders.
  tizen_cli="$(find "$HOME/.tizen-extension-platform" "$HOME/tizen-studio" -maxdepth 8 -type f \( -name tizen -o -name tizen.sh \) -perm -u+x 2>/dev/null | head -1 || true)"
fi
if [ -z "$tizen_cli" ]; then
  echo "Samsung's tizen command line tool was not found."
  echo "In VS Code, run \"Tizen: Install Tizen CLI\" (see README), or run with TIZEN=/path/to/tizen ./samsung/build.sh $profile"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/app/." "$work/project"
# The server address the app uses until it's changed on the display.
sed -i '' "s|^  var DEFAULT_SERVER = .*|  var DEFAULT_SERVER = '$server'; // set by samsung/build.sh|" "$work/project/shell.js"

echo "Signing with certificate profile \"$profile\", server $server"
"$tizen_cli" package -t wgt -s "$profile" -o "$work/out" -- "$work/project"

# The tool doesn't always report failures, so check that a package came out.
wgt="$(find "$work/out" "$work/project" -maxdepth 1 -name '*.wgt' 2>/dev/null | head -1)"
if [ -z "$wgt" ]; then
  echo "No package was made. Check the certificate profile name in the Certificate Manager."
  exit 1
fi
cp "$wgt" "$here/TVWall.wgt"
echo "Done: samsung/TVWall.wgt"
echo "On the display: Home → URL Launcher Settings → Install Web App → http://$server/samsung"
