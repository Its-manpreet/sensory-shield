#!/bin/sh
# OWNER: Agent B. Renders small, short synthetic test clips into assets/clips/ (git-ignored).
# Flashing clips start with FLASH-WARNING-. Warn the room before playing them. Needs ffmpeg.
# Usage: npm run clips
set -e
cd "$(dirname "$0")/../assets/clips"
S=480x270; D=4; ENC="-pix_fmt yuv420p -c:v libvpx-vp9 -b:v 300k -an -loglevel error -y"

flash() { # $1 hz  $2 colour  $3 name
  ffmpeg -f lavfi -i "color=c=black:s=$S:r=30:d=$D" \
    -vf "drawbox=c=$2:t=fill:enable='lt(mod(t\,1/$1)\,1/(2*$1))'" $ENC "FLASH-WARNING-$3.webm"
}
flash 3 white flash-3hz
flash 6 white flash-6hz
flash 4 red   red-flash-4hz
ffmpeg -f lavfi -i "gradients=s=$S:r=30:d=$D:speed=0.02" $ENC normal-video.webm
ls -la
