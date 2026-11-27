#!/bin/bash
# Starts the TV Wall by itself on the Mac that runs the server (the Mac mini):
#  - the server starts when you log in, starts again within seconds if it ever stops, and keeps the
#    Mac and its screen awake while it runs;
#  - with a TV number, that TV's page opens full-screen on this Mac's screen (mac/tv.sh).
#
#   ./mac/autostart.sh install 8   # server + TV 8 on this screen (leave out the 8 for the server only)
#   ./mac/autostart.sh restart     # after a git pull: start the server again with the new code
#   ./mac/autostart.sh status      # is it running?
#   ./mac/autostart.sh uninstall   # back to starting it by hand
#
# The server's messages go to logs/server.log. For a start after a power cut, also set, in System
# Settings: Users & Groups → Automatically log in as this user; Energy → Start up automatically
# after a power failure.

set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)"
agents="$HOME/Library/LaunchAgents"
server_label="ch.ecal.tvwall.server"
tv_label="ch.ecal.tvwall.tv"
domain="gui/$(id -u)"

stop_agent() {
  launchctl bootout "$domain/$1" 2> /dev/null || true
  rm -f "$agents/$1.plist"
}

case "${1:-}" in
  install)
    node="$(command -v node || true)"
    if [ -z "$node" ]; then
      echo "Node isn't installed (or not in this Terminal's PATH): install it first, from https://nodejs.org"
      exit 1
    fi
    stop_agent "$server_label"
    stop_agent "$tv_label"
    if curl -fs --max-time 2 http://localhost:3000/api/time > /dev/null; then
      echo "A server is already running on this Mac (in a Terminal window?). Stop it with Ctrl+C there, then run this again."
      exit 1
    fi
    mkdir -p "$agents" "$dir/logs"
    cat > "$agents/$server_label.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$server_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-dis</string>
    <string>$node</string><string>$dir/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$dir/logs/server.log</string>
  <key>StandardErrorPath</key><string>$dir/logs/server.log</string>
</dict>
</plist>
EOF
    launchctl bootstrap "$domain" "$agents/$server_label.plist"
    echo "The server starts at every login, and again by itself if it stops. Its messages: logs/server.log"
    if [ -n "${2:-}" ]; then
      cat > "$agents/$tv_label.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$tv_label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$dir/mac/tv.sh</string><string>$2</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
      launchctl bootstrap "$domain" "$agents/$tv_label.plist"
      echo "TV $2 opens full-screen on this screen at every login (Cmd+Q to leave it)."
    fi
    ;;
  restart)
    launchctl kickstart -k "$domain/$server_label"
    echo "Server started again."
    ;;
  status)
    if launchctl print "$domain/$server_label" > /dev/null 2>&1; then echo "Starts by itself: yes"; else echo "Starts by itself: no"; fi
    if curl -fs --max-time 2 http://localhost:3000/api/time > /dev/null; then echo "Server answering: yes"; else echo "Server answering: no"; fi
    if launchctl print "$domain/$tv_label" > /dev/null 2>&1; then echo "TV page at login: yes"; else echo "TV page at login: no"; fi
    ;;
  uninstall)
    stop_agent "$server_label"
    stop_agent "$tv_label"
    echo "Done: start the server by hand again (node server.js)."
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
