const { ethers } = require('ethers');
const { provider, signer, TOKENS } = require('./config');

async function testConnection() {
  console.log('Testing BSC connection...');

  // Check we can reach BSC
  const blockNumber = await provider.getBlockNumber();
  console.log('Current BSC block:', blockNumber);

  // Check our wallet address loaded correctly
  console.log('Your wallet address:', signer.address);

  // Check BNB balance (so you know if you have gas money)
  const balance = await provider.getBalance(signer.address);
  console.log('BNB balance:', ethers.formatEther(balance), 'BNB');

  // Check USDT balance
  const usdtAbi = ['function balanceOf(address) view returns (uint256)'];
  const usdt = new ethers.Contract(TOKENS.USDT.address, usdtAbi, provider);
  const usdtBalance = await usdt.balanceOf(signer.address);
  console.log('USDT balance:', ethers.formatUnits(usdtBalance, 18), 'USDT');
}

testConnection().catch(console.error);