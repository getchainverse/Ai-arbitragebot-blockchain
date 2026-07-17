require('dotenv').config();
const { ethers } = require('ethers');

// ─── RPC Connection ───────────────────────────────────────
// This is how your script talks to BSC blockchain
// Think of it like an internet connection to the blockchain
const provider = new ethers.WebSocketProvider(process.env.BSC_WS_URL);

// ─── Your Wallet ──────────────────────────────────────────
// Signer = wallet that can sign and send transactions
// Provider alone can only READ. Signer can READ + WRITE.
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ─── DEX Router Addresses on BSC ─────────────────────────
// These are the official deployed addresses - never change
const DEX_ROUTERS = {
  PANCAKE_V3: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
  PANCAKE_V2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  BISWAP_V2:  '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
};

// ─── Token Addresses on BSC ───────────────────────────────
// WBNB = Wrapped BNB (BNB in ERC20 form so DEXes can use it)
// All others are standard stablecoins/wrapped assets
const TOKENS = {
  WBNB:  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, symbol: 'WBNB' },
  USDT:  { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
  // USDC:  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
  BTCB:  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18, symbol: 'BTCB' },
  // WETH:  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, symbol: 'WETH' },
  // BUSD:  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, symbol: 'BUSD' },
  CAKE:  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, symbol: 'CAKE' },
  // XRP:   { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', decimals: 18, symbol: 'XRP' },
  // DOT:   { address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', decimals: 18, symbol: 'DOT' }
};

// ─── Token Pairs to Watch ─────────────────────────────────
// Each pair = one arbitrage opportunity to scan
// [tokenBorrow, tokenTrade] = borrow first token, trade into second
const PAIRS = [
  { borrow: TOKENS.USDT,  trade: TOKENS.WBNB,  label: 'USDT/WBNB'  },
  { borrow: TOKENS.USDT,  trade: TOKENS.BTCB,  label: 'USDT/BTCB'  },
  // { borrow: TOKENS.USDT,  trade: TOKENS.WETH,  label: 'USDT/WETH'  },
  // { borrow: TOKENS.BUSD,  trade: TOKENS.WBNB,  label: 'USDT/BUSD'  },
  { borrow: TOKENS.USDT,  trade: TOKENS.CAKE,  label: 'USDT/CAKE'  },
  // { borrow: TOKENS.USDT,  trade: TOKENS.XRP,   label: 'USDT/XRP'   },
  // { borrow: TOKENS.USDT,  trade: TOKENS.DOT,   label: 'USDT/DOT'   },
  { borrow: TOKENS.WBNB,  trade: TOKENS.USDT,  label: 'WBNB/USDT'  },
  // { borrow: TOKENS.WBNB,  trade: TOKENS.USDC,  label: 'WBNB/USDC'  },
];

// ─── Flash Loan Settings ──────────────────────────────────
const SETTINGS = {
  FLASH_LOAN_AMOUNT_USDT: ethers.parseUnits('10000', 18), // $10,000 for stablecoin borrows
  FLASH_LOAN_AMOUNT_WBNB: ethers.parseUnits('16', 18),    // ~$10,000 worth of BNB at ~$625
  AAVE_FEE_BPS: 5,
  MIN_PROFIT_USD: 8,
  GAS_LIMIT: 500000,
};

module.exports = { provider, signer, DEX_ROUTERS, TOKENS, PAIRS, SETTINGS };