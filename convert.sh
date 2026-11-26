#!/bin/bash
# Convert videos into a format every TV can play, and put them in the videos folder:
# H.264 High profile level 4.2, at most 1920 px on the long side (portrait or landscape kept),
# a keyframe every second so a TV can jump to any point quickly (needed to keep TVs in sync),
# AAC audio, and fast start so playback begins before the download ends.
#
# Usage:  ./convert.sh originals/*.mp4 ~/Desktop/clip.mov
# Needs ffmpeg (brew install ffmpeg).

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: ./convert.sh video1.mov video2.mp4 ..."
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is missing. Install it with: brew install ffmpeg"
  exit 1
fi

out_dir="$(cd "$(dirname "$0")" && pwd)/videos"
mkdir -p "$out_dir"

for input in "$@"; do
  name="$(basename "${input%.*}").mp4"
  # Write to a hidden file first: the server ignores it until the conversion is complete.
  partial="$out_dir/.$name.part"
  echo "Converting $input → videos/$name"
  ffmpeg -hide_banner -loglevel error -stats -y -i "$input" \
    -vf "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',format=yuv420p" \
    -c:v libx264 -profile:v high -level:v 4.2 -preset slow -crf 18 -maxrate 12M -bufsize 24M \
    -force_key_frames 'expr:gte(t,n_forced*1)' \
    -c:a aac -b:a 192k -ac 2 \
    -movflags +faststart -f mp4 "$partial"
  mv "$partial" "$out_dir/$name"
done

echo "Done. The videos appear in the control panel automatically."
