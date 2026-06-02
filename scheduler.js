/**
 * scheduler.js — Nightly Stripe→HubSpot sync runner
 *
 * Calls sync.run() every day at 23:59 local server time.
 * Keep this process alive with PM2 (recommended) or any process manager.
 *
 * SETUP:
 *   npm install node-cron        (if not already installed)
 *   npm install -g pm2           (recommended for production)
 *
 * START (with PM2 — survives reboots):
 *   pm2 start scheduler.js --name hubspot-sync
 *   pm2 save
 *   pm2 startup                  (follow the printed command to enable on boot)
 *
 * USEFUL PM2 COMMANDS:
 *   pm2 logs hubspot-sync        — tail live logs
 *   pm2 status                   — check process health
 *   pm2 restart hubspot-sync     — restart after code changes
 *   pm2 stop hubspot-sync        — pause without removing
 *
 * ALTERNATIVE — system cron (no PM2 needed):
 *   Run `crontab -e` and add:
 *   59 23 * * * /usr/bin/node /absolute/path/to/sync.js >> /var/log/hubspot-sync.log 2>&1
 */

const cron = require('node-cron');
const { run } = require('./sync');

// Cron expression: minute=59, hour=23, every day
const SCHEDULE = '59 23 * * *';

function timestamp() {
  return new Date().toISOString();
}

cron.schedule(SCHEDULE, async () => {
  console.log(`\n[scheduler] ──────────────────────────────`);
  console.log(`[scheduler] Nightly sync started — ${timestamp()}`);
  console.log(`[scheduler] ──────────────────────────────`);

  try {
    const { created, updated, failed } = await run();
    console.log(`[scheduler] Finished — created=${created} updated=${updated} failed=${failed}`);
  } catch (err) {
    // Log but don't crash the scheduler process — it must stay alive for tomorrow's run
    console.error(`[scheduler] Sync threw an unexpected error:`, err.message);
    if (err.response?.data) console.error('[scheduler] API response:', err.response.data);
  }

  console.log(`[scheduler] Next run scheduled for 23:59 tomorrow.`);
});

console.log(`[scheduler] Running. Nightly sync scheduled for 23:59 (${SCHEDULE}).`);
console.log(`[scheduler] Run "node sync.js" at any time to trigger a manual sync.`);
console.log(`[scheduler] Run "node sync.js --full" to force a full re-sync from Stripe.`);
