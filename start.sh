#!/bin/bash
export DISPLAY=:99.0
Xvfb :99 -screen 0 1024x768x16 >/dev/null 2>&1 &
node app.js