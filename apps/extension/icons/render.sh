#!/bin/sh
# Renders icons/icon.svg to the PNG sizes Chrome uses. Needs rsvg-convert (librsvg).
# Run from apps/extension after changing the SVG: sh icons/render.sh
set -e
for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" icons/icon.svg -o "public/icons/icon-$size.png"
done
