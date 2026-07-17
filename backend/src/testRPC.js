require('dotenv').config();
const { ethers } = require('ethers');

async function test() {
  console.log('Testing RPC connection...');
  console.log('URL:', process.env.BSC_RPC_URL ? 'loaded' : 'MISSING');

  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);

  // Test 1 — basic connection
  try {
    const block = await provider.getBlockNumber();
    console.log('✅ Block number:', block);
  } catch (e) {
    console.log('❌ Block number failed:', e.message);
  }

  // Test 2 — single V2 call (simplest possible)
  try {
    const ROUTER_V2_ABI = ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'];
    const PANCAKE_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
    const USDT = '0x55d398326f99059fF775485246999027B3197955';
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    
    const router = new ethers.Contract(PANCAKE_V2, ROUTER_V2_ABI, provider);
    const amounts = await router.getAmountsOut(
      ethers.parseUnits('100', 18),
      [USDT, WBNB]
    );
    console.log('✅ PancakeSwap V2 price:', ethers.formatEther(amounts[1]), 'WBNB per 100 USDT');
  } catch (e) {
    console.log('❌ V2 call failed:', e.message);
  }

  // Test 3 — single V3 call
  try {
    const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'];
    const QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
    const USDT = '0x55d398326f99059fF775485246999027B3197955';
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

    const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: USDT,
      tokenOut: WBNB,
      amountIn: ethers.parseUnits('100', 18),
      fee: 500,
      sqrtPriceLimitX96: 0
    });
    console.log('✅ PancakeSwap V3 price:', ethers.formatEther(result[0]), 'WBNB per 100 USDT');
  } catch (e) {
    console.log('❌ V3 call failed:', e.message);
  }
  // Test 4 — simulate exactly what scanPair does for USDT/WBNB
  // Test WBNB/USDT two-leg quote
  console.log('\n--- WBNB/USDT two-leg check ---');
  try {
    const WBNB_AMOUNT = ethers.parseUnits('16', 18); // ~$10,000 worth
    const USDT = '0x55d398326f99059fF775485246999027B3197955';
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const ROUTER_V2_ABI = ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'];
    
    // Leg 1: sell WBNB for USDT on PancakeSwap V3 quoter
    const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'];
    const quoter = new ethers.Contract('0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', QUOTER_ABI, provider);
    const leg1 = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: WBNB, tokenOut: USDT,
      amountIn: WBNB_AMOUNT, fee: 500, sqrtPriceLimitX96: 0
    });
    const usdtReceived = leg1[0];
    console.log('Leg 1 - sold 16 WBNB, got USDT:', ethers.formatUnits(usdtReceived, 18));

    // Leg 2: buy WBNB back with that USDT on PancakeSwap V2
    const router = new ethers.Contract('0x10ED43C718714eb63d5aA57B78B54704E256024E', ROUTER_V2_ABI, provider);
    const leg2 = await router.getAmountsOut(usdtReceived, [USDT, WBNB]);
    const wbnbBack = leg2[1];
    console.log('Leg 2 - sold USDT, got WBNB back:', ethers.formatEther(wbnbBack));
    console.log('Started with: 16 WBNB');
    console.log('Ended with:', ethers.formatEther(wbnbBack), 'WBNB');
    
    const delta = BigInt(wbnbBack) - BigInt(WBNB_AMOUNT);
    const sign = delta >= 0n ? '+' : '-';
    console.log('Net delta:', sign, ethers.formatEther(delta < 0n ? -delta : delta), 'WBNB');
  } catch(e) {
    console.log('❌ Failed:', e.message);
  }
}

test().catch(console.error);