#!/bin/sh
# TV Wall: one-time change for a Pi that has already started once, put on its card by
# prepare-card.sh. The Mac can't write the card's Linux part, so the Pi does it itself: cmdline.txt
# tells it to run this script at its next start (systemd.run), then it restarts normally.

# First take this script out of cmdline.txt, so it never runs twice, whatever happens next.
for f in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
  [ -f "$f" ] && sed -i -e 's| systemd.run=[^ ]*||' -e 's| systemd.run_success_action=[^ ]*||' \
    -e 's| systemd.unit=kernel-command-line.target||' "$f"
done

# A new page address and Wi-Fi, when prepare-card.sh was asked for them. The Wi-Fi file holds the
# password, so it's deleted from the card once applied.
conf=/boot/firmware/tvwall-once.conf
if [ -f "$conf" ]; then
  TVWALL_URL=''
  TVWALL_WIFI=''
  . "$conf"
  if [ -n "$TVWALL_URL" ]; then
    sed -i "s|^[[:blank:]]*SOFTWARE_CHROMIUM_AUTOSTART_URL=.*|SOFTWARE_CHROMIUM_AUTOSTART_URL=$TVWALL_URL|" /boot/dietpi.txt
  fi
  if [ "$TVWALL_WIFI" = 1 ] && [ -f /boot/firmware/dietpi-wifi.txt ]; then
    # DietPi's own tool: it reads /boot/dietpi-wifi.txt, keeps it in its database, rewrites wpa_supplicant.conf.
    mv /boot/firmware/dietpi-wifi.txt /boot/dietpi-wifi.txt
    /boot/dietpi/func/dietpi-wifidb 1
  fi
  rm -f "$conf" /boot/firmware/dietpi-wifi.txt
fi

# Display in 1080p on both HDMI ports: a 4K TV otherwise gets 3840x2160, and Chromium's
# 1920x1080 window fills only its top-left quarter.
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/20-tvwall-1080p.conf << 'EOF'
Section "Monitor"
    Identifier "HDMI-1"
    Option "PreferredMode" "1920x1080"
EndSection

Section "Monitor"
    Identifier "HDMI-2"
    Option "PreferredMode" "1920x1080"
EndSection
EOF

sync
exit 0
