const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { provider, PAIRS, SETTINGS } = require('./config');
const { scanAllPairs } = require('./priceScanner');
const { calculateProfit } = require('./profitCalculator');
// const { execute } = require('./executor'); // ← uncomment when ready to go live

// Log file setup
const LOG_DIR = path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'scan_results.csv');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,pair,buyDex,sellDex,netProfitUSD,isProfitable\n');
}

function logToFile(data) {
  const line = `${data.timestamp},${data.pair},${data.buyDex},${data.sellDex},${data.netProfitUSD},${data.isProfitable}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function log(msg) {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${time}] ${msg}`);
}

async function runBot() {
  log('=== ARB BOT STARTING ===');
  log(`Scanning ${PAIRS.length} pairs every 30s`);
  log(`Loan size: $${ethers.formatUnits(SETTINGS.FLASH_LOAN_AMOUNT_USDT, 18)}`);
  log(`Min profit: $${SETTINGS.MIN_PROFIT_USD}`);
  log('');

  let scanCount = 0;
  let opportunitiesFound = 0;

  while (true) {
    scanCount++;

    try {
      const results = await scanAllPairs();
      let bestNetProfit = -Infinity;
      let bestBreakdown = null;

      for (const result of results) {
        if (!result) continue;

        const { isProfitable, netProfitUSD, breakdown } = await calculateProfit(result, provider);

        if (isProfitable) {
          opportunitiesFound++;
          log(`🚨 OPPORTUNITY #${opportunitiesFound} FOUND!`);
          log(`   Pair:   ${breakdown.pair}`);
          log(`   Route:  ${breakdown.route.buy} → ${breakdown.route.sell}`);
          log(`   Profit: ${breakdown.netProfitUSD}`);
          // await execute(result, netProfitUSD);
        } else if (netProfitUSD > bestNetProfit) {
          bestNetProfit = netProfitUSD;
          bestBreakdown = breakdown;
        }

        logToFile({
          timestamp: new Date().toISOString(),
          pair: breakdown.pair,
          buyDex: breakdown.route.buy.split('(')[0].trim(),
          sellDex: breakdown.route.sell.split('(')[0].trim(),
          netProfitUSD: netProfitUSD.toFixed(4),
          isProfitable
        });
      }

      // Always print so you know what's happening
      if (bestBreakdown) {
        log(`Scan #${scanCount} | Best: ${bestBreakdown.pair} | Net: $${bestNetProfit.toFixed(2)} | ${bestBreakdown.route.buy.split('(')[0].trim()} → ${bestBreakdown.route.sell.split('(')[0].trim()}`);
      } else {
        log(`Scan #${scanCount} | No profitable opportunities found`);
      }

    } catch (err) {
      log(`⚠️  Scan error: ${err.message}`);
    }

    // 30 seconds between scans — stays within free Alchemy limits
    // Each scan = ~54 calls × 9 pairs = manageable
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

runBot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});