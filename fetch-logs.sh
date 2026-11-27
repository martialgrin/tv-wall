#!/bin/bash
# Copies the crash tests' logs from the computer running the server to this one, into the logs
# folder next to this script. Run it on a computer on the same network as the server, by cable or
# Wi-Fi: the TP-Link's, or ecalevent if the server is on it too.
#
#   ./fetch-logs.sh                  # the server at 192.168.0.21 (its reserved address on the TP-Link)
#   ./fetch-logs.sh 10.189.8.40      # another address, such as the server's on ecalevent
#   ./fetch-logs.sh mac-mini.local   # or its network name (the server prints both when it starts)
#
# Logs already copied are skipped, unless they grew since (a test still running).

set -euo pipefail

server="${1:-192.168.0.21}"
server="${server#http://}"
server="${server%%/*}"
[[ "$server" == *:* ]] || server="$server:3000"
dir="$(cd "$(dirname "$0")" && pwd)/logs"

list=$(curl -fsS --max-time 5 "http://$server/api/logs") || {
  echo "Can't reach the server at http://$server/"
  echo "Check that the server is running, and that this computer is on the same network."
  echo "On ecalevent, give the server's address or name there: ./fetch-logs.sh <address> (the server prints it when it starts)."
  exit 1
}

mkdir -p "$dir"
got=0
total=0
while read -r name size; do
  [[ "$name" =~ ^test-[A-Za-z0-9_-]+\.jsonl$ ]] || continue
  total=$((total + 1))
  file="$dir/$name"
  if [ -f "$file" ] && [ "$(wc -c < "$file" | tr -d ' ')" -ge "$size" ]; then continue; fi
  curl -fsS --max-time 600 -o "$file.part" "http://$server/logs/$name"
  mv "$file.part" "$file"
  echo "Copied $name ($((size / 1000)) KB)"
  got=$((got + 1))
done < <(printf '%s' "$list" | node -e '
  let data = "";
  process.stdin.on("data", chunk => (data += chunk)).on("end", () => {
    for (const log of JSON.parse(data).logs) console.log(`${log.name} ${log.size}`);
  });')

echo "$got copied, $total on the server. They're in $dir"
