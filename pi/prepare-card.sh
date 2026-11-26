#!/bin/bash
# Prepare a DietPi card (Raspberry Pi 5) to show one TV of the wall. Put the card in the Mac, then:
#
#   ./pi/prepare-card.sh <TV number> [server address]
#   e.g. ./pi/prepare-card.sh 6
#        WIFI_SSID='TP-Link_1234' ./pi/prepare-card.sh 6
#        ./pi/prepare-card.sh 6 Martials-MacBook-Pro-181.local:3000
#
# WIFI_SSID is the Wi-Fi the Pi joins (default ecalevent). The server address defaults to this
# Mac's address on that network: its Wi-Fi address for ecalevent, otherwise its address on the
# cable to the TP-Link. It asks for the Wi-Fi password; set WIFI_PASSWORD=... to skip the question.
# Optional: LOGIN_PASSWORD (replaces DietPi's default "dietpi"), CARD=/Volumes/<name> if several
# DietPi cards are in the Mac.
#
# A fresh card: on first boot the Pi joins the Wi-Fi, installs Chromium (10-20 minutes), then opens
# http://<server>/<TV number> full-screen at every start, with sound and no screen blanking.
# A card that has already started: the display settings are updated, and the Wi-Fi and the page
# too when WIFI_SSID or a server address is given. The Pi applies them itself at its next start.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
screen="${1:-}"
if ! [[ "$screen" =~ ^[0-9]+$ ]] || [ "$screen" -lt 1 ]; then
  echo "Usage: ./pi/prepare-card.sh <TV number> [server address]"
  exit 1
fi

ssid="${WIFI_SSID:-ecalevent}"
server="${2:-}"
if [ -z "$server" ]; then
  # The Mac's address on the network the Pi joins: Wi-Fi for ecalevent, else the cable to the TP-Link.
  wifi_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  cable_ip="$(ifconfig | awk '/^[a-z]/ { iface = $1 } /inet / { print iface, $2 }' | grep -v -E '^(lo0|en0):' \
    | awk '$2 ~ /^192\.168\./ { print $2; exit }' || true)"
  if [ "$ssid" = "ecalevent" ]; then ip="$wifi_ip"; else ip="${cable_ip:-$wifi_ip}"; fi
  if [ -z "$ip" ]; then
    echo "This Mac has no address on that network. Connect it, or give the server address."
    exit 1
  fi
  server="$ip:3000"
fi
server="${server#http://}"
server="${server%/}"
[[ "$server" == *:* ]] || server="$server:3000"
url="http://$server/$screen"

# A DietPi card: freshly flashed (dietpi.txt on it), or already started once
# (DietPi then moves dietpi.txt onto the Pi's system, and only config.txt and cmdline.txt stay here).
is_dietpi_card() {
  [ -f "$1/dietpi.txt" ] || { [ -f "$1/cmdline.txt" ] && grep -qi dietpi "$1/config.txt" 2>/dev/null; }
}

# Find the card: the only mounted DietPi card, unless CARD says which.
card="${CARD:-}"
if [ -z "$card" ]; then
  cards=()
  for volume in /Volumes/*; do
    is_dietpi_card "$volume" && cards+=("$volume")
  done
  if [ "${#cards[@]}" -eq 0 ]; then
    echo "No DietPi card found. Flash DietPi on it, take it out and put it back in the Mac."
    exit 1
  fi
  if [ "${#cards[@]}" -gt 1 ]; then
    echo "Several DietPi cards are in the Mac: ${cards[*]}. Run with CARD=/Volumes/<name>."
    exit 1
  fi
  card="${cards[0]}"
fi
if ! is_dietpi_card "$card"; then
  echo "$card doesn't look like a DietPi card."
  exit 1
fi

started=0
[ -f "$card/dietpi.txt" ] || started=1
# On a started card, the Wi-Fi and the page change only when asked for (WIFI_SSID, or a server address).
# A new Wi-Fi also means a new page address: the Mac's address on that network.
change_wifi=1
change_page=1
if [ "$started" -eq 1 ]; then
  [ -n "${WIFI_SSID:-}" ] || change_wifi=0
  [ -n "${WIFI_SSID:-}" ] || [ -n "${2:-}" ] || change_page=0
  echo "This card has already started once: DietPi now keeps its settings on the Pi itself."
  echo "It applies the changes itself at its next start: the 1080p display$([ "$change_wifi" -eq 1 ] && echo ", the Wi-Fi \"$ssid\"")$([ "$change_page" -eq 1 ] && echo ", the page $url")."
  echo
else
  for file in dietpi-wifi.txt config.txt; do
    if [ ! -f "$card/$file" ]; then
      echo "$card/$file is missing: is this a DietPi card?"
      exit 1
    fi
  done
fi

password="${WIFI_PASSWORD:-}"
if [ "$change_wifi" -eq 1 ] && [ -z "$password" ]; then
  read -r -s -p "Password for the Wi-Fi \"$ssid\": " password
  echo
fi
if [ "$change_wifi" -eq 1 ] && [ -z "$password" ]; then
  echo "No Wi-Fi password given."
  exit 1
fi

# set_value <file> <key> <value> [top]: replace the "key=..." line (or a commented-out one),
# or add one at the end, or at the top with "top" (config.txt sections below may target other models).
# Values travel through the environment so that no character in them gets interpreted.
set_value() {
  local file="$1"
  KEY="$2" VALUE="$3" WHERE="${4:-end}" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; line = key "=" value }
    { lines[NR] = $0; probe = $0; sub(/^[ \t]*#?[ \t]*/, "", probe)
      if (index(probe, key "=") == 1) { if (index($0, key "=") == 1) active[NR] = 1; else commented[NR] = 1 } }
    END {
      # Prefer the active line; otherwise the first commented-out one.
      for (i = 1; i <= NR; i++) if (active[i]) { at = i; break }
      if (!at) for (i = 1; i <= NR; i++) if (commented[i]) { at = i; break }
      if (!at && ENVIRON["WHERE"] == "top") print line
      for (i = 1; i <= NR; i++) {
        if (i == at) print line
        else if (!active[i]) print lines[i]
      }
      if (!at && ENVIRON["WHERE"] != "top") print line
    }
  ' "$file" > "$file.tvwall" && cat "$file.tvwall" > "$file" && rm "$file.tvwall"
}

# DietPi reads its Wi-Fi keys between single quotes, with ' written as '\''.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

d="$card/dietpi.txt"
if [ "$started" -eq 0 ]; then
echo "Preparing $card for TV $screen: $url"

# First boot: no questions, Wi-Fi on, Chromium installed and started full-screen on this TV's page.
set_value "$d" AUTO_SETUP_AUTOMATED 1
set_value "$d" AUTO_SETUP_TIMEZONE Europe/Zurich
set_value "$d" AUTO_SETUP_NET_HOSTNAME "tv$screen"
set_value "$d" AUTO_SETUP_NET_WIFI_ENABLED 1
set_value "$d" AUTO_SETUP_NET_WIFI_COUNTRY_CODE CH
set_value "$d" AUTO_SETUP_INSTALL_SOFTWARE_ID chromium
set_value "$d" AUTO_SETUP_AUTOSTART_TARGET_INDEX 11      # Chromium, without desktop
set_value "$d" AUTO_SETUP_AUTOSTART_LOGIN_USER root
set_value "$d" SURVEY_OPTED_IN 0
set_value "$d" CONFIG_SOUNDCARD rpi-bcm2835-hdmi         # Pi 5: sound over HDMI
set_value "$d" SOFTWARE_CHROMIUM_RES_X 1920
set_value "$d" SOFTWARE_CHROMIUM_RES_Y 1080
set_value "$d" SOFTWARE_CHROMIUM_AUTOSTART_URL "$url"
if [ -n "${LOGIN_PASSWORD:-}" ]; then
  set_value "$d" AUTO_SETUP_GLOBAL_PASSWORD "$LOGIN_PASSWORD"
fi

w="$card/dietpi-wifi.txt"
set_value "$w" "aWIFI_SSID[0]" "$(quote "$ssid")"
set_value "$w" "aWIFI_KEY[0]" "$(quote "$password")"
set_value "$w" "aWIFI_KEYMGR[0]" "'WPA-PSK'"

# Run once after the first-boot installs: sound without a click, no blanking, Bonjour.
cp "$here/Automation_Custom_Script.sh" "$card/Automation_Custom_Script.sh"
fi

# Pi 5 graphics driver with HDMI sound, no screen standby, no slow-down before 80 °C.
c="$card/config.txt"
# Exactly one line, on, without ",noaudio" (which would mute HDMI): in place of the first existing one, or at the top.
if grep -Eq '^[[:blank:]]*#?[[:blank:]]*dtoverlay=vc4-kms-v3d' "$c"; then
  awk '/^[ \t]*#?[ \t]*dtoverlay=vc4-kms-v3d/ { if (!done) print "dtoverlay=vc4-kms-v3d"; done = 1; next } { print }' \
    "$c" > "$c.tvwall"
else
  { echo 'dtoverlay=vc4-kms-v3d'; cat "$c"; } > "$c.tvwall"
fi
cat "$c.tvwall" > "$c" && rm "$c.tvwall"
set_value "$c" hdmi_blanking 0 top
set_value "$c" temp_limit 80 top

# Start-up screen in 1080p, on either port (cmdline.txt is a single line, read at every start).
# The display server Chromium runs on gets 1080p from Automation_Custom_Script.sh: otherwise a
# 4K TV gets 3840x2160 and Chromium's 1920x1080 window fills only its top-left quarter.
k="$card/cmdline.txt"
if [ -f "$k" ]; then
  line="$(head -n 1 "$k" | sed -E 's/[[:blank:]]*(video=HDMI-A-[12]:|systemd\.run=|systemd\.run_success_action=|systemd\.unit=)[^[:blank:]]*//g; s/[[:blank:]]+$//')"
  extra=' video=HDMI-A-1:1920x1080@60 video=HDMI-A-2:1920x1080@60'
  if [ "$started" -eq 1 ]; then
    # The display setting belongs on the card's Linux part, which the Mac can't write. Like Raspberry Pi
    # Imager, ask the Pi to run a script once at its next start: it applies the setting, takes itself
    # out of cmdline.txt, then restarts normally.
    cp "$here/tvwall-once.sh" "$card/tvwall-once.sh"
    extra="$extra systemd.run=/boot/firmware/tvwall-once.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target"
    # The Wi-Fi and the page live on the Pi's system too: the one-time script applies them from these
    # files, then deletes them (the Wi-Fi file holds the password).
    rm -f "$card/tvwall-once.conf" "$card/dietpi-wifi.txt"
    : > "$card/tvwall-once.conf"
    [ "$change_page" -eq 1 ] && printf 'TVWALL_URL=%s\n' "$(quote "$url")" >> "$card/tvwall-once.conf"
    if [ "$change_wifi" -eq 1 ]; then
      echo 'TVWALL_WIFI=1' >> "$card/tvwall-once.conf"
      {
        echo "aWIFI_SSID[0]=$(quote "$ssid")"
        echo "aWIFI_KEY[0]=$(quote "$password")"
        echo "aWIFI_KEYMGR[0]='WPA-PSK'"
      } > "$card/dietpi-wifi.txt"
    fi
  fi
  printf '%s%s\n' "$line" "$extra" > "$k"
fi

# macOS leaves "._" files on the card; they are useless to the Pi.
dot_clean -m "$card" 2>/dev/null || true
sync

echo
if [ "$started" -eq 1 ]; then
  echo "Done: graphics driver, no standby, 1080p display$([ "$change_wifi" -eq 1 ] && echo ", Wi-Fi \"$ssid\"")$([ "$change_page" -eq 1 ] && echo ", page $url")."
  if [ "$change_page" -eq 1 ] && ! curl -s -m 3 -o /dev/null "$url"; then
    echo "  Note: $url doesn't answer from this Mac right now. Start the server before turning the Pi on."
  fi
  echo "Eject the card (diskutil eject \"$card\"), put it back in the Pi, then turn it on."
  echo "At that start it applies the changes and restarts by itself, then opens its page."
  exit 0
fi
echo "Done. TV $screen, Pi name tv$screen, Wi-Fi \"$ssid\"."
grep -E '^(SOFTWARE_CHROMIUM_AUTOSTART_URL|AUTO_SETUP_NET_HOSTNAME)=' "$d" | sed 's/^/  /'
if ! curl -s -m 3 -o /dev/null "$url"; then
  echo "  Note: $url doesn't answer from this Mac right now. Start the server before turning the Pi on."
fi
[ -n "${LOGIN_PASSWORD:-}" ] || echo "  Login password: DietPi's default (dietpi). Set LOGIN_PASSWORD=... to choose one."
echo "Eject the card (diskutil eject \"$card\"), put it in the Pi, then turn it on."
