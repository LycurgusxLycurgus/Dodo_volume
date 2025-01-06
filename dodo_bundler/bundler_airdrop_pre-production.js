require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  getAccount,
  transfer,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// CONFIG SECTION
// ==============
const MAINNET_RPC = process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(MAINNET_RPC, 'confirmed');

// Helper Functions
function decodePrivateKey(bs58Key) {
  const secretKey = bs58.decode(bs58Key);
  return Keypair.fromSecretKey(secretKey);
}

async function getTokenBalance(connection, ownerPublicKey, mintPublicKey) {
  const ata = await getAssociatedTokenAddress(mintPublicKey, ownerPublicKey);
  try {
    const accountInfo = await getAccount(connection, ata);
    return Number(accountInfo.amount);
  } catch (err) {
    return 0;
  }
}

async function transferWithRetries(connection, payerKeypair, fromOwnerKeypair, mintPublicKey, destinationPubkey, amount, maxRetries = 3, delayMs = 3000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const fromATA = await getAssociatedTokenAddress(mintPublicKey, fromOwnerKeypair.publicKey);
      const toATA = await getAssociatedTokenAddress(mintPublicKey, new PublicKey(destinationPubkey));

      // Ensure the destination ATA exists
      await getAccount(connection, toATA).catch(() => {
        throw new Error("Destination token account does not exist. Please create it first.");
      });

      // Updated transfer with proper transaction confirmation
      const transferTx = await transfer(
        connection,
        fromOwnerKeypair, // payer
        fromATA,
        toATA,
        fromOwnerKeypair.publicKey, // authority
        amount
      );

      // Wait for confirmation using the proper method
      const confirmation = await connection.confirmTransaction({
        signature: transferTx,
        lastValidBlockHeight: await connection.getBlockHeight(),
        blockhash: (await connection.getLatestBlockhash()).blockhash
      });

      if (confirmation.value.err) {
        throw new Error(`Transfer failed: ${confirmation.value.err}`);
      }

      console.log(`Transfer successful on attempt ${attempt}. Tx: https://solscan.io/tx/${transferTx}`);
      return transferTx;
    } catch (err) {
      console.error(`Transfer attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`Retrying in ${delayMs/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw new Error(`All ${maxRetries} transfer attempts failed.`);
      }
    }
  }
}

// Main function that loads files and executes transfers
async function executeAirdrop(configDir = path.join(__dirname, 'db')) {
  // Load files
  const traderWalletsPath = path.join(configDir, 'trader_wallets.json');
  const mintConfigPath = path.join(configDir, 'mintConfig.json');
  const airdropWalletsPath = path.join(configDir, 'airdrop_wallets.txt');

  // Validate files exist
  if (!fs.existsSync(traderWalletsPath)) {
    throw new Error("trader_wallets.json not found");
  }
  if (!fs.existsSync(mintConfigPath)) {
    throw new Error("mintConfig.json not found");
  }
  if (!fs.existsSync(airdropWalletsPath)) {
    throw new Error("airdrop_wallets.txt not found");
  }

  const traderWallets = JSON.parse(fs.readFileSync(traderWalletsPath, 'utf8'));
  const { mintAddress } = JSON.parse(fs.readFileSync(mintConfigPath, 'utf8'));
  const airdropWalletLines = fs.readFileSync(airdropWalletsPath, 'utf8').trim().split('\n');

  if (!mintAddress) {
    throw new Error("mintAddress not provided in mintConfig.json");
  }

  const mintPublicKey = new PublicKey(mintAddress);

  // When doing transfers, use the updated confirmation pattern
  for (let i = 0; i < traderWallets.length; i++) {
    const tw = traderWallets[i];
    const traderKeypair = decodePrivateKey(tw.privateKey);
    const airdropDest = airdropWalletLines[i].trim();
    const balance = await getTokenBalance(connection, traderKeypair.publicKey, mintPublicKey);

    if (balance > 0) {
      console.log(`\nTransferring ${balance} tokens from Trader ${tw.id} to ${airdropDest}...`);
      await transferWithRetries(
        connection,
        traderKeypair,
        traderKeypair,
        mintPublicKey,
        airdropDest,
        balance
      );
    } else {
      console.log(`\nTrader ${tw.id} has zero tokens, skipping transfer...`);
    }
  }

  // ... rest of the airdrop logic ...
}

// Only run if this is the main module
if (require.main === module) {
  executeAirdrop().catch(console.error);
}

module.exports = {
  decodePrivateKey,
  getTokenBalance,
  transferWithRetries,
  executeAirdrop
};
