#!/bin/bash
# Shows one TV's page full-screen on this Mac, for a Mac whose screen is one of the TVs (such as the
# Mac mini that runs the server). It opens in its own browser window and profile, apart from your
# usual one, with sound allowed to start on its own.
#
#   ./mac/tv.sh 8                  # TV 8, from the server on this Mac
#   ./mac/tv.sh 8 192.168.0.21     # TV 8, from the server on another computer
#
# To leave it: Cmd+Q.

set -euo pipefail

tv="${1:-8}"
server="${2:-localhost}"
server="${server#http://}"
server="${server%%/*}"
[[ "$server" == *:* ]] || server="$server:3000"
url="http://$server/$tv"
profile="$HOME/Library/Application Support/TV Wall browser"

# The server may still be starting, for example just after the Mac started: wait for it.
for _ in $(seq 1 90); do
  curl -fs --max-time 2 "http://$server/api/time" > /dev/null && break
  sleep 1
done

for app in "Google Chrome" "Brave Browser" "Chromium" "Microsoft Edge"; do
  if [ -d "/Applications/$app.app" ]; then
    open -na "$app" --args --user-data-dir="$profile" --kiosk --autoplay-policy=no-user-gesture-required \
      --no-first-run --no-default-browser-check --noerrdialogs --disable-infobars \
      --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-features=Translate \
      --overscroll-history-navigation=0 "$url"
    echo "TV $tv is open full-screen in $app: $url (Cmd+Q to leave)"
    exit 0
  fi
done

echo "Google Chrome isn't installed, so this opens Safari, which can't start in full screen by itself:"
echo "press Ctrl+Cmd+F there. In Safari, the sound may need a click on the page."
open -a Safari "$url"
