const { ethers } = require('ethers');
const { provider, TOKENS, DEX_ROUTERS } = require('./config');

// ─── What is a Quoter? ────────────────────────────────────
// PancakeSwap V3 has a Quoter contract deployed on BSC.
// You call it with: token in, token out, fee tier, amount in
// It returns: how many tokens out you would receive
// It is a READ call — costs zero gas, just simulates the swap
// This is how we know the "real" price including liquidity depth

const QUOTER_V3_ADDRESS = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'; // PancakeSwap V3 Quoter on BSC

// ─── What is an ABI? ─────────────────────────────────────
// ABI = Application Binary Interface
// It tells ethers.js what functions exist in the contract
// and what parameters they take
// We only need the one function we're calling — quoteExactInputSingle
// Alternative: import the full ABI from a JSON file, but for one
// function, writing it inline is cleaner

const QUOTER_V3_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
];

// ─── PancakeSwap V2 / Biswap Router ABI ──────────────────
// V2 DEXes work differently — they have a router with
// getAmountsOut() function. You pass a PATH (array of token
// addresses) and the amount in, it returns amount out at each step
// path = [tokenIn, tokenOut] for single hop

const ROUTER_V2_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'
];

// ─── Fee Tiers ────────────────────────────────────────────
// V3 pools exist in multiple fee tiers — 0.01%, 0.05%, 0.25%, 1%
// Each fee tier is a separate pool with separate liquidity
// 100  = 0.01% — stablecoin pairs
// 500  = 0.05% — stable/major pairs  
// 2500 = 0.25% — most common on PancakeSwap V3
// 10000 = 1%   — exotic pairs
// We try the most liquid one for each pair

const FEE_TIERS = {
  STABLE: 100,
  LOW: 500,
  MEDIUM: 2500,
  HIGH: 10000
};

// ─── Get Price from PancakeSwap V3 ───────────────────────
// Returns: how many units of tokenOut you get for amountIn of tokenIn
// Returns null if the pool doesn't exist or call fails

async function getPriceV3(tokenIn, tokenOut, amountIn, feeTier) {
  return withRetry(async () => {
    const quoter = new ethers.Contract(QUOTER_V3_ADDRESS, QUOTER_V3_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
      fee: feeTier,
      sqrtPriceLimitX96: 0
    });
    return result[0];
  });
}

// ─── Get Price from PancakeSwap V2 or Biswap ─────────────
// V2 is simpler — one function, no fee tiers
// The fee is always 0.25% and is built into the contract

async function getPriceV2(routerAddress, tokenIn, tokenOut, amountIn) {
  return withRetry(async () => {
    const router = new ethers.Contract(routerAddress, ROUTER_V2_ABI, provider);
    const path = [tokenIn.address, tokenOut.address];
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[1];
  });
}

// ─── Retry wrapper ────────────────────────────────────────
// When Alchemy returns 429, wait briefly and try again
// Most rate limit errors resolve within 1-2 seconds
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) return null; // give up after last retry
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        return null; // non-rate-limit error, don't retry
      }
    }
  }
  return null;
}

// ─── Two-Leg Quote ────────────────────────────────────────
// This is the CORRECT way to check arbitrage profitability.
// Leg 1: buy tradeToken with borrowAmount on buyDex
// Leg 2: sell that exact tradeToken amount back on sellDex
// Final: how much borrowToken did we end up with vs started with?
//
// Why didn't we do this before?
// Because it requires two separate quote calls per pair per DEX combo.
// More calls = slower. But accuracy matters more than speed here.

async function twoLegQuote(pair, amountIn, buyDex, sellDex) {
  let tradeAmountReceived = null;

  // ── Leg 1: Buy trade token on buyDex ──────────────────
  if (buyDex.version === 3) {
    tradeAmountReceived = await getPriceV3(
      pair.borrow, pair.trade, amountIn, buyDex.fee
    );
  } else {
    tradeAmountReceived = await getPriceV2(
      buyDex.router, pair.borrow, pair.trade, amountIn
    );
  }

  if (!tradeAmountReceived) return null;

  // ── Leg 2: Sell that exact amount on sellDex ──────────
  // NOW we use the ACTUAL received amount, not the original amountIn
  // This is what was missing before
  let borrowTokenReceived = null;

  if (sellDex.version === 3) {
    borrowTokenReceived = await getPriceV3(
      pair.trade, pair.borrow, tradeAmountReceived, sellDex.fee
    );
  } else {
    borrowTokenReceived = await getPriceV2(
      sellDex.router, pair.trade, pair.borrow, tradeAmountReceived
    );
  }

  if (!borrowTokenReceived) return null;

  return {
    amountIn,
    tradeAmountReceived,
    borrowTokenReceived,
    // How much more/less borrow token did we end up with?
    netDelta: BigInt(borrowTokenReceived) - BigInt(amountIn)
  };
}
// ─── Scan One Pair Across All DEXes ──────────────────────
// This is the core function — for one token pair,
// get the price from every DEX and return all results

async function scanPair(pair, amountIn) {

  // Build list of all DEXes with their configs
  const dexes = [];

  // PancakeSwap V3 — try fee tiers
  // Check all DEXes in parallel — all fire at same time, wait for all to finish
  const [v3Results, pcV2Result, biswapResult] = await Promise.all([
    // V3: try all fee tiers in parallel too
    Promise.all(
      [500, 3000, 10000].map(fee =>
        getPriceV3(pair.borrow, pair.trade, amountIn, fee)
          .then(price => ({ fee, price }))
      )
    ),
    getPriceV2(DEX_ROUTERS.PANCAKE_V2, pair.borrow, pair.trade, amountIn),
    getPriceV2(DEX_ROUTERS.BISWAP_V2, pair.borrow, pair.trade, amountIn),
  ]);

  // Pick best V3 fee tier
  const bestV3 = v3Results
    .filter(r => r.price !== null && r.price !== undefined)
    .reduce((best, curr) => {
      if (!best) return curr;
      return curr.price > best.price ? curr : best;
    }, null);

  if (bestV3) {
    dexes.push({ dex: 'PancakeSwap V3', router: DEX_ROUTERS.PANCAKE_V3, version: 3, fee: bestV3.fee });
  }
  if (pcV2Result) {
    dexes.push({ dex: 'PancakeSwap V2', router: DEX_ROUTERS.PANCAKE_V2, version: 2, fee: 25 });
  }
  if (biswapResult) {
    dexes.push({ dex: 'Biswap', router: DEX_ROUTERS.BISWAP_V2, version: 2, fee: 10 });
  }
  if (dexes.length < 2) return null;

  let bestResult = null;

  // Build all valid buy/sell combinations
  const combinations = [];
  for (const buyDex of dexes) {
    for (const sellDex of dexes) {
      if (buyDex.dex !== sellDex.dex) {
        combinations.push({ buyDex, sellDex });
      }
    }
  }

  // Run all combinations in parallel
  const comboResults = await Promise.all(
    combinations.map(({ buyDex, sellDex }) =>
      twoLegQuote(pair, amountIn, buyDex, sellDex)
        .then(result => ({ buyDex, sellDex, result }))
        .catch(() => null)
    )
  );

  // Find best profitable result
  for (const combo of comboResults) {
    if (!combo || !combo.result) continue;
    const { buyDex, sellDex, result } = combo;

    
      if (!bestResult || result.netDelta > bestResult.netDelta) {
        bestResult = {
          pair,
          amountIn,
          bestBuy: { ...buyDex, amountOut: result.tradeAmountReceived },
          bestSell: { ...sellDex, amountOut: result.borrowTokenReceived },
          tradeAmountReceived: result.tradeAmountReceived,
          borrowTokenReceived: result.borrowTokenReceived,
          netDelta: result.netDelta,
          spreadPercent: (Number(result.netDelta) / Number(amountIn)) * 100
        };
      }
    
  }
  return bestResult;
}

// ─── Scan All Pairs ───────────────────────────────────────
// Loops through every pair in your config and scans each one

async function scanAllPairs() {
  const { PAIRS, SETTINGS } = require('./config');

  const results = await Promise.all(
    PAIRS.map(pair => {
      // Pick loan amount based on which token we're borrowing
      const amountIn = pair.borrow.symbol === 'WBNB'
        ? SETTINGS.FLASH_LOAN_AMOUNT_WBNB
        : SETTINGS.FLASH_LOAN_AMOUNT_USDT;

      return scanPair(pair, amountIn).catch(err => {
        console.error(`scanPair error for ${pair.label}:`, err.message);
        return null;
      });
    })
  );

  return results.filter(r => r !== null);
}

module.exports = { scanAllPairs, scanPair, getPriceV3, getPriceV2 };

// ─── Run directly if called as main script ────────────────
// This lets you test this file alone with: node src/priceScanner.js
// When index.js imports it, this block won't run automatically

if (require.main === module) {
  scanAllPairs()
    .then(() => {
      console.log('\n=== Scan Complete ===');
      process.exit(0);
    })
    .catch(err => {
      console.error('Scanner error:', err);
      process.exit(1);
    });
}