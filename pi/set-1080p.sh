#!/bin/bash
# Run on a Raspberry Pi that is already set up, from the Mac, to fix a page that fills only
# a quarter of a 4K TV: the display then starts in 1080p, the size of Chromium's window.
#
#   ssh root@tv6.local 'bash -s' < pi/set-1080p.sh
#
# (DietPi's login password is "dietpi" unless you chose one.) New cards get this from
# Automation_Custom_Script.sh, so they don't need it.

set -e
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
echo "1080p set on $(hostname). Restarting…"
reboot
