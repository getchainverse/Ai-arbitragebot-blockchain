const { ethers } = require('ethers');
const { signer, provider } = require('./config');

// ─── Your deployed contract ABI ───────────────────────────
// Matches FlashLoanArb.sol's actual requestFlashLoan signature exactly —
// DexConfig structs, not generic bytes. This was the bug in the old version.

const FLASH_LOAN_ARB_ABI = [
  'function requestFlashLoan(address token, uint256 amount, (address router, uint8 version, uint24 fee) buyDex, (address router, uint8 version, uint24 fee) sellDex, address tradeToken, uint256 minProfit, uint256 buyMinOut, uint256 sellMinOut, uint256 quoteExpiry) external',
  'function owner() external view returns (address)',
  'function paused() external view returns (bool)',
  'function tokenMaxLoan(address) external view returns (uint256)',
  'function approvedRouters(address) external view returns (bool)',
  'function quoteValidityWindow() external view returns (uint256)',
  'event TradeExecuted(address indexed token, uint256 profit, address buyDex, address sellDex, uint8 buyVersion, uint8 sellVersion, uint256 timestamp)',
];

// ─── Build a DexConfig struct ──────────────────────────────
// Matches the contract's DexConfig struct exactly:
//   struct DexConfig { address router; uint8 version; uint24 fee; }
// V2 DEXes (PancakeSwap V2, Biswap) don't use a fee tier — pass 0.
// V3 DEXes must use 500, 3000, or 10000 — contract reverts on anything else.

function buildDexConfig(dexInfo) {
  return {
    router:  dexInfo.router,
    version: dexInfo.version,
    fee:     dexInfo.version === 3 ? dexInfo.fee : 0,
  };
}

// ─── Pre-flight checks ────────────────────────────────────
// Read-only calls — free, instant, catch misconfiguration before spending gas

async function preFlightCheck(contractAddress, borrowToken, tradeToken, buyRouter, sellRouter) {
  const contract = new ethers.Contract(contractAddress, FLASH_LOAN_ARB_ABI, provider);

  const isPaused = await contract.paused();
  if (isPaused) throw new Error('Contract is paused — cannot execute');

  // Both borrow token AND trade token must be whitelisted —
  // this was easy to miss, contract checks tokenMaxLoan for both
  const borrowMax = await contract.tokenMaxLoan(borrowToken);
  if (borrowMax === 0n) throw new Error(`Borrow token ${borrowToken} not supported — call addSupportedToken()`);

  const tradeMax = await contract.tokenMaxLoan(tradeToken);
  if (tradeMax === 0n) throw new Error(`Trade token ${tradeToken} not supported — call addSupportedToken()`);

  const buyOk = await contract.approvedRouters(buyRouter);
  if (!buyOk) throw new Error(`Buy router ${buyRouter} not approved — call addApprovedRouter()`);

  const sellOk = await contract.approvedRouters(sellRouter);
  if (!sellOk) throw new Error(`Sell router ${sellRouter} not approved — call addApprovedRouter()`);

  return { borrowMax, tradeMax };
}

// ─── Main execute function ────────────────────────────────
// scanResult comes from priceScanner.js — already two-leg quoted and verified profitable

async function execute(scanResult, netProfitUSD) {
  const contractAddress = process.env.CONTRACT_ADDRESS;

  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('CONTRACT_ADDRESS not set in .env — deploy your contract first');
  }

  const { pair, amountIn, bestBuy, bestSell, tradeAmountReceived, borrowTokenReceived } = scanResult;

  console.log(`\n[EXECUTOR] Opportunity detected!`);
  console.log(`  Pair:    ${pair.label}`);
  console.log(`  Buy on:  ${bestBuy.dex}`);
  console.log(`  Sell on: ${bestSell.dex}`);
  console.log(`  Expected profit: $${netProfitUSD.toFixed(4)}`);

  // ── Step 1: Pre-flight checks ────────────────────────
  console.log(`[EXECUTOR] Running pre-flight checks...`);
  await preFlightCheck(
    contractAddress,
    pair.borrow.address,
    pair.trade.address,
    bestBuy.router,
    bestSell.router
  );
  console.log(`[EXECUTOR] Pre-flight passed ✅`);

  // ── Step 2: Build DexConfig structs ──────────────────
  const buyDexConfig  = buildDexConfig(bestBuy);
  const sellDexConfig = buildDexConfig(bestSell);

  // ── Step 3: Slippage-protected minimums ──────────────
  // These map DIRECTLY to the contract's buyMinOut / sellMinOut.
  // The scanner already gave us the simulated amounts — we shave off
  // a safety margin since real execution can differ slightly from quote.
  // Why 0.5%? Matches the SLIPPAGE_BPS buffer used in profitCalculator.js
  const SLIPPAGE_TOLERANCE_BPS = 50n; // 0.5%

  const buyMinOut  = (tradeAmountReceived  * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  const sellMinOut = (borrowTokenReceived * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;

  // ── Step 4: minProfit ─────────────────────────────────
  // This is the contract's FINAL safety check — receivedAmount must be
  // >= repayAmount + minProfit, or the entire tx reverts.
  // We pass our SETTINGS.MIN_PROFIT_USD (converted to token units) so the
  // contract enforces the exact same threshold the backend already decided.
  const { SETTINGS } = require('./config');
  const minProfitTokenUnits = ethers.parseUnits(
    SETTINGS.MIN_PROFIT_USD.toString(),
    pair.borrow.decimals
  );

  // ── Step 5: Quote expiry ──────────────────────────────
  // Must be inside the contract's quoteValidityWindow (60s by default)
  // Give it 50 seconds of margin to allow time for tx to be mined
  const deadline = Math.floor(Date.now() / 1000) + 50;

  // ── Step 6: Estimate gas (also acts as final simulation) ──
  const contract = new ethers.Contract(contractAddress, FLASH_LOAN_ARB_ABI, signer);

  console.log(`[EXECUTOR] Estimating gas...`);
  let gasEstimate;
  try {
    gasEstimate = await contract.requestFlashLoan.estimateGas(
      pair.borrow.address,
      amountIn,
      buyDexConfig,
      sellDexConfig,
      pair.trade.address,
      minProfitTokenUnits,
      buyMinOut,
      sellMinOut,
      deadline
    );
    console.log(`[EXECUTOR] Gas estimate: ${gasEstimate.toString()} units`);
  } catch (err) {
    throw new Error(`Gas estimation failed — trade would revert: ${err.message}`);
  }

  // ── Step 7: Gas price ─────────────────────────────────
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  console.log(`[EXECUTOR] Gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);

  // ── Step 8: Send transaction ──────────────────────────
  console.log(`[EXECUTOR] Sending transaction...`);
  const tx = await contract.requestFlashLoan(
    pair.borrow.address,
    amountIn,
    buyDexConfig,
    sellDexConfig,
    pair.trade.address,
    minProfitTokenUnits,
    buyMinOut,
    sellMinOut,
    deadline,
    {
      gasLimit: gasEstimate * 120n / 100n, // +20% buffer
      gasPrice: gasPrice,
    }
  );

  console.log(`[EXECUTOR] Transaction sent! Hash: ${tx.hash}`);
  console.log(`[EXECUTOR] View on BSCScan: https://bscscan.com/tx/${tx.hash}`);

  // ── Step 9: Wait for confirmation ─────────────────────
  console.log(`[EXECUTOR] Waiting for confirmation...`);
  const receipt = await tx.wait(1);

  if (receipt.status === 1) {
    console.log(`[EXECUTOR] ✅ SUCCESS! Confirmed in block ${receipt.blockNumber}`);
    console.log(`[EXECUTOR] Gas used: ${receipt.gasUsed.toString()}`);
    return { success: true, hash: tx.hash, receipt };
  } else {
    throw new Error(`Transaction reverted in block ${receipt.blockNumber}`);
  }
}

module.exports = { execute, preFlightCheck, buildDexConfig };