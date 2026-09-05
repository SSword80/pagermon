const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RTL_FM = process.env.RTL_FM;
const RTL_TEST = process.env.RTL_TEST;
const MULTIMON = process.env.MULTIMON;
const PAGERMON_URL = process.env.PAGERMON_URL || 'http://localhost:3000/api/messages';
const API_KEY = process.env.PAGERMON_API_KEY;

const FREQUENCY = '157.950M';
const RESTART_DELAY_MS = 5000;
const DUPLICATE_WINDOW_MS = 30000;

// Logs will be stored in: server/logs/sdr-bridge.log
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sdr-bridge.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}`;

  if (isError) {
    console.error(entry);
  } else {
    console.log(entry);
  }

  fs.appendFile(LOG_FILE, entry + '\n', error => {
    if (error) {
      console.error(`[Logging error] ${error.message}`);
    }
  });
}

let rtl = null;
let multimon = null;
let buffer = '';
let shuttingDown = false;
let restartTimer = null;

const recentMessages = new Map();

const stats = {
  totalSent: 0,
  POCSAG1200: 0,
  POCSAG2400: 0,
  filtered: 0,
  duplicates: 0,
  errors: 0,
  restarts: 0
};

function checkSDR() {
  return new Promise((resolve) => {
    log('Checking RTL-SDR device...');

    const test = spawn(RTL_TEST, ['-t']);
    let output = '';

    test.stdout.on('data', data => {
      output += data.toString();
    });

    test.stderr.on('data', data => {
      output += data.toString();
    });

    test.on('error', error => {
      log(`Could not run rtl_test: ${error.message}`, true);
      resolve(false);
    });

    test.on('close', code => {
      if (
        output.includes('Found 1 device(s)') ||
        output.includes('Using device 0')
      ) {
        log('RTL-SDR device detected successfully.');
        resolve(true);
      } else {
        log('No RTL-SDR device detected.', true);
        log(`rtl_test exited with code ${code}`, true);
        resolve(false);
      }
    });
  });
}

async function startBridge() {
  if (shuttingDown) return;

  log('');
  log('Starting SDR decoder...');

  const deviceAvailable = await checkSDR();

  if (!deviceAvailable) {
    if (!shuttingDown) {
      log('SDR device is unavailable.', true);
      restartBridge();
    }
    return;
  }

  if (shuttingDown) return;

  buffer = '';

  rtl = spawn(RTL_FM, [
    '-f', FREQUENCY,
    '-M', 'fm',
    '-s', '22050',
    '-E', 'dc',
    '-'
  ]);

  multimon = spawn(MULTIMON, [
    '-t', 'raw',
    '-a', 'POCSAG1200',
    '-a', 'POCSAG2400',
    '-'
  ]);

  rtl.stdout.pipe(multimon.stdin);

  rtl.stderr.on('data', data => {
    const lines = data.toString().trim().split(/\r?\n/);
    lines.forEach(line => {
      if (line.trim()) log(`[rtl_fm] ${line}`);
    });
  });

  multimon.stderr.on('data', data => {
    const lines = data.toString().trim().split(/\r?\n/);
    lines.forEach(line => {
      if (line.trim()) log(`[multimon] ${line}`);
    });
  });

  multimon.stdout.on('data', chunk => {
    buffer += chunk.toString();

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();

    for (const line of lines) {
      handleLine(line);
    }
  });

  rtl.on('error', error => {
    log(`Could not start rtl_fm: ${error.message}`, true);
  });

  multimon.on('error', error => {
    log(`Could not start multimon-ng: ${error.message}`, true);
  });

  rtl.on('close', code => {
    if (!shuttingDown) {
      log(`rtl_fm stopped unexpectedly with code ${code}`, true);
      restartBridge();
    }
  });

  multimon.on('close', code => {
    if (!shuttingDown) {
      log(`multimon-ng stopped unexpectedly with code ${code}`, true);
      restartBridge();
    }
  });
}

function restartBridge() {
  if (shuttingDown || restartTimer) return;

  stats.restarts++;

  log(
    `Restarting SDR decoder in ${RESTART_DELAY_MS / 1000} seconds...`
  );

  if (rtl && !rtl.killed) {
    rtl.kill();
  }

  if (multimon && !multimon.killed) {
    multimon.kill();
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBridge();
  }, RESTART_DELAY_MS);
}

async function handleLine(line) {
  log(`[decoded] ${line}`);

  const match = line.match(
    /^(POCSAG(?:512|1200|2400)):\s+Address:\s+(\d+)\s+Function:\s+(\d+)(?:\s+Alpha:\s*)?(.*)$/i
  );

  if (!match) return;

  const protocol = match[1].toUpperCase();
  const address = match[2];

  let message = match[4].trim();

  // Ignore Skyper encoded messages
  if (message.startsWith('Skyper:')) {
    stats.filtered++;
    log(`[filtered] Skyper message ignored: ${address}`);
    return;
  }

  // Remove multimon control markers
  message = message
    .replace(/\\?<ETX>/gi, '')
    .replace(/\\?<STX>/gi, '')
    .replace(/\\?<US>/gi, '')
    .replace(/\bETX\b/gi, '')
    .replace(/\bSTX\b/gi, '')
    .replace(/\bUS\b/gi, '')
    .trim();

  if (!message) {
    stats.filtered++;
    return;
  }

  // Duplicate protection
  const messageKey = `${protocol}|${address}|${message}`;
  const now = Date.now();
  const previous = recentMessages.get(messageKey);

  if (previous && (now - previous) < DUPLICATE_WINDOW_MS) {
    stats.duplicates++;
    log(`[duplicate] Ignored duplicate: ${address}`);
    return;
  }

  recentMessages.set(messageKey, now);

  // Remove expired duplicate entries
  for (const [key, timestamp] of recentMessages) {
    if ((now - timestamp) > DUPLICATE_WINDOW_MS) {
      recentMessages.delete(key);
    }
  }

  const payload = {
    address,
    message,
    datetime: Math.floor(Date.now() / 1000),
    source: 'RTL-SDR',
    protocol
  };

  try {
    const response = await fetch(PAGERMON_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    if (response.ok) {
      stats.totalSent++;
      stats[protocol] = (stats[protocol] || 0) + 1;

      log(`[PagerMon] Sent ${protocol} ${address}: ${message}`);
    } else {
      stats.errors++;
      log(`[PagerMon] Error ${response.status}: ${text}`, true);
    }
  } catch (error) {
    stats.errors++;
    log(`[PagerMon] Connection error: ${error.message}`, true);
  }
}

setInterval(() => {
  log(
    `[Stats] Total sent: ${stats.totalSent} | ` +
    `POCSAG1200: ${stats.POCSAG1200} | ` +
    `POCSAG2400: ${stats.POCSAG2400} | ` +
    `Duplicates: ${stats.duplicates} | ` +
    `Filtered: ${stats.filtered} | ` +
    `Errors: ${stats.errors} | ` +
    `Restarts: ${stats.restarts}`
  );
}, 60000);

function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  log('');
  log('Shutting down SDR bridge...');

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (rtl && !rtl.killed) {
    rtl.kill();
  }

  if (multimon && !multimon.killed) {
    multimon.kill();
  }

  setTimeout(() => {
    log('SDR bridge stopped.');
    process.exit(0);
  }, 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('PagerMon SDR bridge started.');
log(`Listening on ${FREQUENCY} MHz...`);
log('Decoders: POCSAG1200, POCSAG2400');
log(`Duplicate window: ${DUPLICATE_WINDOW_MS / 1000} seconds`);
log(`Auto-restart delay: ${RESTART_DELAY_MS / 1000} seconds`);
log(`Log file: ${LOG_FILE}`);

startBridge();