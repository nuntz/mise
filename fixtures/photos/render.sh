#!/usr/bin/env bash
# Renders sample-dish.jpg, a fictional dish on a plate, with ImageMagick: rerun it after changing it.
set -euo pipefail
cd "$(dirname "$0")"
magick -size 900x600 xc:"#8f6440" -seed 7 -attenuate 0.6 +noise Gaussian -motion-blur 0x40+0 -modulate 100,70 \
  \( -size 900x600 xc:none -fill "#00000055" -draw "ellipse 462,318 250,250 0,360" -blur 0x18 \) -composite \
  -fill "#f3ece0" -draw "circle 450,300 450,62" \
  -fill "#e6dccb" -draw "circle 450,300 450,92" \
  -fill "#c98a3c" -draw "ellipse 390,280 95,62 0,360" -fill "#a8682a" -draw "ellipse 520,330 85,58 0,360" \
  -fill "#e8c84a" -draw "circle 560,220 560,180" -fill "#f4e27a" -draw "circle 560,220 560,190" \
  -fill "#d9a85a" -draw "circle 360,390 360,365" -draw "circle 410,410 410,388" -fill "#cf9a4c" -draw "circle 455,400 455,378" \
  -fill "#4f7a3a" -draw "ellipse 470,200 40,10 20,340" -fill "#5d8a44" -draw "ellipse 340,200 34,9 -30,330" \
  -strip -quality 80 sample-dish.jpg
