#!/bin/bash

LOG=/home/sam/pagermon/startup.log
NODE=/home/sam/.nvm/versions/node/v20.20.2/bin/node

echo "===== PagerMon startup: $(date) =====" >> "$LOG"

# Start PagerMon server
cd /home/sam/pagermon/server || exit 1
"$NODE" app.js >> "$LOG" 2>&1 &

# Wait for server to initialise
sleep 5

# Start SDR + decoder + reader
cd /home/sam/pagermon/client || exit 1
bash reader.sh >> "$LOG" 2>&1
