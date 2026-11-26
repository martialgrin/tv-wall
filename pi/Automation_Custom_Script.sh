#!/bin/bash
# TV Wall: finishes the kiosk set-up. DietPi runs this once, at the end of the first boot,
# after Chromium is installed. Log: /var/lib/dietpi/logs/dietpi-firstrun-setup.log

# Chromium options, read by /usr/bin/chromium at every start:
# play sound without a click (the panel's sound buttons), and never show a prompt or error dialog.
cat > /etc/chromium.d/tvwall << 'EOF'
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-infobars --hide-crash-restore-bubble --disable-session-crashed-bubble --disable-features=Translate --check-for-update-interval=31536000 --overscroll-history-navigation=0 --disable-pinch"
EOF

# Wait (up to 5 minutes) for the TV Wall server before opening the page, so a Pi that starts
# before the Mac doesn't stay on an error page. Also read by /usr/bin/chromium at every start.
cat > /etc/chromium.d/tvwall-wait << 'EOF'
tvwall_url=$(sed -n '/^[[:blank:]]*SOFTWARE_CHROMIUM_AUTOSTART_URL=/{s/^[^=]*=//p;q;}' /boot/dietpi.txt)
for tvwall_try in $(seq 300); do
  curl -s -m 2 -o /dev/null "$tvwall_url" && break
  sleep 1
done
EOF

# Never blank or power down the screen.
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-tvwall-noblank.conf << 'EOF'
Section "ServerFlags"
    Option "BlankTime" "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime" "0"
EndSection
EOF

# Display in 1080p on both HDMI ports. A 4K TV otherwise gets 3840x2160, and Chromium's
# 1920x1080 window fills only its top-left quarter; the boot option video= doesn't reach the display server.
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

# Bonjour: the Pi answers to <hostname>.local, and can find the Mac by its .local name.
apt-get install -y avahi-daemon libnss-mdns

exit 0
