const { ethers } = require('ethers');
const { SETTINGS } = require('./config');

// ─── Why do we need this? ─────────────────────────────────
// The price scanner tells us GROSS spread — the raw price difference.
// But that spread is NOT your profit. You must subtract:
//   1. AAVE flash loan fee (0.05%)
//   2. Buy DEX swap fee
//   3. Sell DEX swap fee
//   4. Estimated gas cost (converted to USD)
//   5. Slippage buffer (price moves while tx is pending)
//
// Only what remains after ALL of these is real profit.
// This calculator does that math and gives a yes/no answer.

// ─── Fee Tier to Percentage ───────────────────────────────
// V3 fee tiers are stored as integers (100, 500, 2500, 10000)
// We need them as basis points for math
// 1 basis point = 0.01%
// So fee tier 100 = 0.01%, stored as 100 in contract = 100/1000000

function feeTierToBps(feeTier, version) {
  if (version === 2) {
    // All V2 DEXes charge a fixed fee, but it varies per DEX
    // PancakeSwap V2 = 25 bps (0.25%)
    // Biswap = 10 bps (0.10%) — this is Biswap's advantage
    return feeTier; // already stored as bps in our config
  }
  // V3: fee tier is in units of 1/1,000,000
  // 100 = 0.01% = 1 bps
  // 500 = 0.05% = 5 bps
  // 2500 = 0.25% = 25 bps
  return feeTier / 100;
}

// ─── Estimate Gas Cost in USD ─────────────────────────────
// Gas cost = gasUnits * gasPrice (in BNB) * BNB price (in USD)
// We cannot know exact gas until we run it, so we estimate.
// A flash loan arb on BSC typically uses 300,000 - 500,000 gas units.
// We use 400,000 as a safe estimate.
//
// Alternative approach: query current gas price from the network
// and BNB price from an oracle. We do a simplified version here
// using a hardcoded BNB price for now — we'll improve this later.

async function estimateGasCostUSD(provider) {
  try {
    // Get current gas price from BSC network (in wei)
    const feeData = await provider.getFeeData();
    const gasPriceWei = feeData.gasPrice;

    // Estimated gas units for our flash loan transaction
    const estimatedGasUnits = 400000n; // BigInt

    // Gas cost in BNB (wei)
    const gasCostWei = gasPriceWei * estimatedGasUnits;

    // Convert to BNB
    const gasCostBNB = parseFloat(ethers.formatEther(gasCostWei));

    // BNB price in USD — hardcoded for now, we'll make this dynamic later
    // Why hardcoded? Getting live BNB price requires an oracle call
    // which adds complexity. For now $600 is a safe estimate.
    // TODO: replace with live price from Chainlink or CoinGecko API
    const BNB_PRICE_USD = 600;

    const gasCostUSD = gasCostBNB * BNB_PRICE_USD;

    return {
      gasPriceGwei: parseFloat(ethers.formatUnits(gasPriceWei, 'gwei')).toFixed(2),
      gasCostBNB: gasCostBNB.toFixed(6),
      gasCostUSD: gasCostUSD.toFixed(4)
    };
  } catch (error) {
    // If we can't get gas price, use a safe high estimate
    // Better to overestimate gas than underestimate and lose money
    console.warn('Could not fetch gas price, using default estimate');
    return {
      gasPriceGwei: '3',
      gasCostBNB: '0.00072',
      gasCostUSD: '0.432'
    };
  }
}

// ─── Main Profit Calculation ──────────────────────────────
// Takes a scan result from priceScanner and decides:
//   - Is this profitable?
//   - How much profit after all fees?
//   - Should we execute?
//
// Parameters:
//   scanResult  — output from scanPair() in priceScanner.js
//   provider    — ethers provider (to get live gas price)
//
// Returns an object with full breakdown and a go/no-go decision

async function calculateProfit(scanResult, provider) {
  const { pair, amountIn, bestBuy, bestSell, borrowTokenReceived } = scanResult;

  // ── Step 1: Amounts in human-readable token units ─────
  const borrowAmountFloat = parseFloat(
    ethers.formatUnits(amountIn, pair.borrow.decimals)
  );
  const returnedAmountFloat = parseFloat(
    ethers.formatUnits(borrowTokenReceived, pair.borrow.decimals)
  );

  // ── Step 2: Convert everything to USD ─────────────────
  // We need a USD price for the borrow token to calculate real profit
  // For stablecoins (USDT, USDC, BUSD): price = $1.00
  // For WBNB: get approximate price from the scan data itself
  // How? We know amountIn (WBNB) and the USDT received in leg 1
  // borrowTokenPrice = usdtReceived / wbnbSent = price of 1 WBNB in USD

  let borrowTokenPriceUSD = 1.0; // default for stablecoins

  const STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'BUSD', 'DAI'];
  if (!STABLECOIN_SYMBOLS.includes(pair.borrow.symbol)) {
    // For non-stablecoins, derive price from the trade itself
    // bestBuy.amountOut = how much tradeToken (e.g. USDT) we got for amountIn of borrow token
    // If borrow=WBNB, trade=USDT: amountOut is in USDT, so price = amountOut / amountIn
    const tradeAmountFloat = parseFloat(
      ethers.formatUnits(bestBuy.amountOut, pair.trade.decimals)
    );

    if (STABLECOIN_SYMBOLS.includes(pair.trade.symbol)) {
      // trade token is a stablecoin → direct USD price
      borrowTokenPriceUSD = tradeAmountFloat / borrowAmountFloat;
    } else {
      // Neither token is a stablecoin — too complex for now, skip
      return {
        isProfitable: false,
        netProfitUSD: -9999,
        breakdown: {
          pair: pair.label,
          borrowAmount: `${borrowAmountFloat} ${pair.borrow.symbol}`,
          grossProfitUSD: '$0',
          costs: {},
          totalCosts: '$0',
          netProfitUSD: '$-9999',
          isProfitable: false,
          decision: '❌ SKIP — non-stablecoin pair not yet supported',
          route: {
            buy: `${bestBuy.dex} (v${bestBuy.version})`,
            sell: `${bestSell.dex} (v${bestSell.version})`
          }
        }
      };
    }
  }

  // ── Step 3: Gross profit in USD ───────────────────────
  // How much MORE borrow token did we end up with vs started?
  // Convert that difference to USD
  const tokenDifference = returnedAmountFloat - borrowAmountFloat;
  const grossProfitUSD = tokenDifference * borrowTokenPriceUSD;

  // ── Step 4: AAVE fee in USD ───────────────────────────
  const aaveFeeBps = SETTINGS.AAVE_FEE_BPS; // 5 bps = 0.05%
  const aaveFeeUSD = (borrowAmountFloat * borrowTokenPriceUSD) * (aaveFeeBps / 10000);

  // ── Step 5: DEX fees in USD ───────────────────────────
  function feeTierToBps(feeTier, version) {
    if (version === 2) return feeTier;
    return feeTier / 100;
  }
  const buyFeeBps = feeTierToBps(bestBuy.fee, bestBuy.version);
  const sellFeeBps = feeTierToBps(bestSell.fee, bestSell.version);
  const loanValueUSD = borrowAmountFloat * borrowTokenPriceUSD;
  const buyFeeUSD = loanValueUSD * (buyFeeBps / 10000);
  const sellFeeUSD = loanValueUSD * (sellFeeBps / 10000);

  // ── Step 6: Slippage buffer ───────────────────────────
  const SLIPPAGE_BPS = 10; // 0.10%
  const slippageUSD = loanValueUSD * (SLIPPAGE_BPS / 10000);

  // ── Step 7: Gas cost ──────────────────────────────────
  const gasEstimate = await estimateGasCostUSD(provider);
  const gasCostUSD = parseFloat(gasEstimate.gasCostUSD);

  // ── Step 8: Total costs and net profit ────────────────
  const totalCosts = aaveFeeUSD + buyFeeUSD + sellFeeUSD + slippageUSD + gasCostUSD;
  const netProfitUSD = grossProfitUSD - totalCosts;
  const isProfitable = netProfitUSD >= SETTINGS.MIN_PROFIT_USD;

  const breakdown = {
    pair: pair.label,
    borrowAmount: `${borrowAmountFloat.toFixed(4)} ${pair.borrow.symbol} (~$${loanValueUSD.toFixed(2)})`,
    grossProfitUSD: `$${grossProfitUSD.toFixed(4)}`,
    costs: {
      aaveFee:    `$${aaveFeeUSD.toFixed(4)}   (${aaveFeeBps} bps)`,
      buyDexFee:  `$${buyFeeUSD.toFixed(4)}   (${buyFeeBps} bps on ${bestBuy.dex})`,
      sellDexFee: `$${sellFeeUSD.toFixed(4)}   (${sellFeeBps} bps on ${bestSell.dex})`,
      slippage:   `$${slippageUSD.toFixed(4)}   (${SLIPPAGE_BPS} bps buffer)`,
      gas:        `$${gasCostUSD.toFixed(4)}   (${gasEstimate.gasPriceGwei} gwei)`
    },
    totalCosts:   `$${totalCosts.toFixed(4)}`,
    netProfitUSD: `$${netProfitUSD.toFixed(4)}`,
    isProfitable,
    decision: isProfitable
      ? `✅ EXECUTE — $${netProfitUSD.toFixed(4)} profit`
      : `❌ SKIP — $${netProfitUSD.toFixed(4)} after fees (min: $${SETTINGS.MIN_PROFIT_USD})`,
    route: {
      buy:  `${bestBuy.dex} (v${bestBuy.version}, fee: ${buyFeeBps} bps)`,
      sell: `${bestSell.dex} (v${bestSell.version}, fee: ${sellFeeBps} bps)`
    },
    gasInfo: gasEstimate
  };

  return { isProfitable, netProfitUSD, breakdown };
}

module.exports = { calculateProfit, estimateGasCostUSD };

// ─── Run directly for testing ─────────────────────────────
if (require.main === module) {
  const { provider, PAIRS, SETTINGS: S } = require('./config');
  const { scanAllPairs } = require('./priceScanner');

  async function test() {
    console.log('=== Profit Calculator Test ===\n');

    const opportunities = await scanAllPairs();

    for (const result of opportunities) {
      const { breakdown } = await calculateProfit(result, provider);

      console.log(`\n─── ${breakdown.pair} ───`);
      console.log(`Borrow amount : ${breakdown.borrowAmount}`);
      console.log(`Gross profit  : ${breakdown.grossProfitUSD}`);
      console.log(`  AAVE fee    : ${breakdown.costs.aaveFee}`);
      console.log(`  Buy fee     : ${breakdown.costs.buyDexFee}`);
      console.log(`  Sell fee    : ${breakdown.costs.sellDexFee}`);
      console.log(`  Slippage    : ${breakdown.costs.slippage}`);
      console.log(`  Gas         : ${breakdown.costs.gas}`);
      console.log(`Total costs   : ${breakdown.totalCosts}`);
      console.log(`Net profit    : ${breakdown.netProfitUSD}`);
      console.log(`Route         : Buy on ${breakdown.route.buy}`);
      console.log(`              : Sell on ${breakdown.route.sell}`);
      console.log(`Decision      : ${breakdown.decision}`);
    }

    console.log('\n=== Done ===');
  }

  test().catch(console.error);
}