#!/bin/bash

if [ "$#" -ne 6 ]; then
    echo "Usage: $0 <input_video> <width> <height> <output_file> <video_bitrate> <audio_bitrate>"
    exit 1
fi

INPUT_VIDEO="$1"
WIDTH="$2"
HEIGHT="$3"
OUTPUT_FILE="$4"
VIDEO_BITRATE="$5"
AUDIO_BITRATE="$6"

ffmpeg -i "$INPUT_VIDEO" \
    -vf scale="$WIDTH":"$HEIGHT" \
    -c:v libx264 -threads 4 -preset superfast \
    -b:v "$VIDEO_BITRATE" \
    -b:a "$AUDIO_BITRATE" \
    -y "$OUTPUT_FILE"
