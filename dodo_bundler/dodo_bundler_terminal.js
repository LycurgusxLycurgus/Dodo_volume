require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('cross-fetch');
const FormData = require('form-data');
const readline = require('readline');
const { JitoJsonRpcClient } = require('jito-js-rpc');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Constants and Configurations
const DB_DIR = path.join(__dirname, 'db');
const MAINNET_RPC = process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(MAINNET_RPC, 'confirmed');
const jitoClient = new JitoJsonRpcClient('https://mainnet.block-engine.jito.wtf/api/v1');

// Move the core functions directly into this file to avoid dependency issues
async function requestAndSendBundle(bundledTxArgs, signersArray) {
  try {
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundledTxArgs)
    });

    if (response.status !== 200) {
      throw new Error("Failed to get transaction: " + await response.text());
    }

    const transactions = await response.json();
    if (!Array.isArray(transactions) || transactions.length !== bundledTxArgs.length) {
      throw new Error("Unexpected response. Expected exactly one transaction.");
    }

    const serializedTx = bs58.decode(transactions[0]);
    const tx = VersionedTransaction.deserialize(new Uint8Array(serializedTx));

    console.log(`Simulating the ${bundledTxArgs[0].action} transaction...`);
    const simulation = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true });
    if (simulation.value.err) {
      console.error("Simulation failed:", simulation.value.err);
      throw new Error(`${bundledTxArgs[0].action} transaction simulation failed`);
    }

    tx.sign(signersArray);
    const signedSerialized = tx.serialize();
    const signedEncodedTransaction = bs58.encode(signedSerialized);

    console.log(`Sending the ${bundledTxArgs[0].action} bundle to Jito...`);
    const jitoResponse = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [
          [signedEncodedTransaction]
        ]
      })
    });

    if (!jitoResponse.ok) {
      throw new Error("Jito bundle submission failed: " + await jitoResponse.text());
    }

    const jitoJson = await jitoResponse.json();
    if (!jitoJson.result) {
      console.warn("No result field in jitoResponse:", jitoJson);
      throw new Error("Failed to get bundle_id from Jito response.");
    }

    return jitoJson.result;
  } catch (error) {
    console.error(`Error in requestAndSendBundle for action ${bundledTxArgs[0].action}:`, error.message);
    throw error;
  }
}

async function waitForBundleConfirmation(bundleId, timeout = 45000) {
  const pollInterval = 1000;
  const maxTime = Date.now() + timeout;

  while (Date.now() < maxTime) {
    try {
      const statusCheckResponse = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]]
        })
      });

      const statusCheckJson = await statusCheckResponse.json();
      if (statusCheckJson.result && statusCheckJson.result.value && statusCheckJson.result.value[0]) {
        const bundleStatus = statusCheckJson.result.value[0];
        console.log("Bundle status:", bundleStatus.confirmation_status);
        if (bundleStatus.confirmation_status === "confirmed" || bundleStatus.confirmation_status === "finalized") {
          return bundleStatus.confirmation_status;
        }
      }
    } catch (error) {
      console.error("Error checking bundle status:", error.message);
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Bundle confirmation timed out after ${timeout / 1000} seconds.`);
}

// Helper function to get user input
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Helper function to create wallet
function createWallet(type, id = null) {
  const wallet = Keypair.generate();
  const walletData = {
    id: id || type,
    publicKey: wallet.publicKey.toBase58(),
    privateKey: bs58.encode(wallet.secretKey)
  };
  return { wallet, walletData };
}

// Function to check wallet balance
async function checkWalletBalance(wallet, walletType) {
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`${walletType} balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  return balance;
}

// Function to fund wallet
async function fundWallet(sourceWallet, destinationPublicKey, amount) {
  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sourceWallet.publicKey,
        toPubkey: destinationPublicKey,
        lamports: amount,
      })
    );

    const signature = await connection.sendTransaction(
      transaction,
      [sourceWallet]
    );
    
    // Wait for confirmation with longer timeout and retry logic
    let confirmed = false;
    let retries = 0;
    const maxRetries = 4; // Total wait time: 4 * 30 = 120 seconds
    
    while (!confirmed && retries < maxRetries) {
      try {
        await connection.confirmTransaction(signature, 'confirmed');
        confirmed = true;
      } catch (confirmError) {
        retries++;
        if (retries < maxRetries) {
          console.log(`Waiting for confirmation... attempt ${retries}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second wait between retries
          
          // Check if transaction was actually confirmed despite timeout
          const status = await connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || 
              status.value?.confirmationStatus === 'finalized') {
            confirmed = true;
            break;
          }
        }
      }
    }

    if (!confirmed) {
      // Final check before declaring failure
      const finalStatus = await connection.getSignatureStatus(signature);
      if (finalStatus.value?.confirmationStatus === 'confirmed' || 
          finalStatus.value?.confirmationStatus === 'finalized') {
        confirmed = true;
      } else {
        throw new Error(`Transaction was not confirmed after ${maxRetries * 30} seconds`);
      }
    }
    
    console.log(`Funded ${destinationPublicKey.toBase58()} with ${amount / LAMPORTS_PER_SOL} SOL`);
    console.log(`Transaction: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (error) {
    throw new Error(`Failed to fund wallet: ${error.message}`);
  }
}

async function main() {
  try {
    console.log('=== Starting Pre-Production Test Setup ===\n');

    // 1. Ask for number of trader wallets (changed to 2-25 temporarily for tests)
    const numTraders = parseInt(await askQuestion('How many trader wallets would you like to create? (2-25): ')); 
    if (numTraders < 2 || numTraders > 25) {
      throw new Error('Number of trader wallets must be between 2 and 25');
    }

    // 2. Create wallets
    console.log('\n=== Creating Wallets ===');
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    // Create dev wallet
    const { wallet: devWallet, walletData: devWalletData } = createWallet('dev_wallet');
    fs.writeFileSync(
      path.join(DB_DIR, 'dev_wallet.json'),
      JSON.stringify(devWalletData, null, 2)
    );
    console.log('Dev wallet created:', devWallet.publicKey.toBase58());

    // Create airdrop wallet
    const { wallet: airdropWallet, walletData: airdropWalletData } = createWallet('airdrop_wallet');
    fs.writeFileSync(
      path.join(DB_DIR, 'airdrop_wallet.json'),
      JSON.stringify(airdropWalletData, null, 2)
    );
    console.log('Airdrop wallet created:', airdropWallet.publicKey.toBase58());

    // Create trader wallets
    const traderWallets = [];
    const traderWalletsData = [];
    for (let i = 0; i < numTraders; i++) {
      const { wallet, walletData } = createWallet(null, `trader_${i}`);
      traderWallets.push(wallet);
      traderWalletsData.push(walletData);
      console.log(`Trader wallet ${i} created:`, wallet.publicKey.toBase58());
    }
    fs.writeFileSync(
      path.join(DB_DIR, 'trader_wallets.json'),
      JSON.stringify(traderWalletsData, null, 2)
    );

    // 3. Check all wallet balances
    console.log('\n=== Current Wallet Balances ===');
    await checkWalletBalance(devWallet, 'Dev wallet');
    await checkWalletBalance(airdropWallet, 'Airdrop wallet');
    for (let i = 0; i < traderWallets.length; i++) {
      await checkWalletBalance(traderWallets[i], `Trader wallet ${i}`);
    }

    // 4. Ask user to fund dev and airdrop wallets
    console.log('\n=== Wallet Funding Requirements ===');
    console.log('Dev wallet needs minimum 0.025 SOL');
    console.log(`Airdrop wallet needs minimum ${(0.005 * numTraders).toFixed(3)} SOL for trader wallets`);
    console.log('\nPlease fund the wallets and press Enter when ready...');
    await askQuestion('');

    // 5. Ask for trader wallet funding amount and distribute
    const fundingAmount = parseFloat(await askQuestion('\nHow much SOL should be sent to each trader wallet? '));
    if (isNaN(fundingAmount) || fundingAmount < 0.005) {
      throw new Error('Invalid funding amount. Must be at least 0.005 SOL');
    }

    console.log('\n=== Funding Trader Wallets ===');
    for (const wallet of traderWallets) {
      await fundWallet(
        airdropWallet,
        wallet.publicKey,
        fundingAmount * LAMPORTS_PER_SOL
      );
      // Add delay between transactions
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 6. Get token information from user
    console.log('\n=== Token Creation Setup ===');
    console.log('Please ensure new-moon-face.png is in the root folder.');
    await askQuestion('Press Enter when the image is ready...');

    const tokenName = await askQuestion('Enter token name: ');
    const tokenSymbol = await askQuestion('Enter token symbol: ');
    const tokenDescription = await askQuestion('Enter token description: ');
    const tokenTwitter = await askQuestion('Enter Twitter URL: ');
    const tokenTelegram = await askQuestion('Enter Telegram URL: ');
    const tokenWebsite = await askQuestion('Enter website URL: ');

    // 7. Create and buy token using isolated_token_creation_test.js functions
    console.log('\n=== Creating and Buying Token ===');

    // Upload metadata
    const fileData = fs.readFileSync("./new-moon-face.png");
    const formData = new FormData();
    formData.append("file", fileData, { filename: "new-moon-face.png", contentType: "image/png" });
    formData.append("name", tokenName);
    formData.append("symbol", tokenSymbol);
    formData.append("description", tokenDescription);
    formData.append("twitter", tokenTwitter);
    formData.append("telegram", tokenTelegram);
    formData.append("website", tokenWebsite);
    formData.append("showName", "true");

    const metadataResponse = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData
    });

    if (!metadataResponse.ok) {
      throw new Error("Failed to upload metadata: " + await metadataResponse.text());
    }

    const metadataJson = await metadataResponse.json();
    console.log("Metadata uploaded. URI:", metadataJson.metadataUri);

    // Generate mint keypair
    const mintKeypair = Keypair.generate();
    console.log("Generated mint keypair:", mintKeypair.publicKey.toBase58());

    // Create token with the same parameters as isolated_token_creation_test.js
    const createTxArgs = [{
      publicKey: devWallet.publicKey.toBase58(),
      action: "create",
      tokenMetadata: {
        name: metadataJson.metadata.name,
        symbol: metadataJson.metadata.symbol,
        uri: metadataJson.metadataUri
      },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: 0.001,
      slippage: 10,
      priorityFee: 0.0005,
      pool: "pump"
    }];

    const createBundleId = await requestAndSendBundle(createTxArgs, [mintKeypair, devWallet]);
    console.log(`Waiting for create bundle (${createBundleId}) to be confirmed...`);
    const createStatus = await waitForBundleConfirmation(createBundleId);
    console.log(`Create bundle confirmed with status: ${createStatus}`);

    // Execute buys with trader wallets in groups of 5
    console.log("Proceeding with buy attempts using trader wallets...");
    
    // Split trader wallets into groups of 5
    const walletGroups = [];
    for (let i = 0; i < traderWallets.length; i += 5) {
      walletGroups.push(traderWallets.slice(i, i + 5));
    }

    // Process each group in parallel
    const buyPromises = walletGroups.map(async (walletGroup, groupIndex) => {
      try {
        console.log(`Processing wallet group ${groupIndex + 1}/${walletGroups.length}`);
        
        // Create bundled buy transactions for the group (one transaction per wallet in the group)
        const buyTxArgs = walletGroup.map(wallet => ({
          publicKey: wallet.publicKey.toBase58(),
          action: "buy",
          mint: mintKeypair.publicKey.toBase58(),
          denominatedInSol: "true",
          amount: 0.001,
          slippage: 10,
          priorityFee: 0.0005,
          pool: "pump"
        }));

        // Implement retry mechanism for each group
        let currentTry = 0;
        const maxRetries = 45;
        let lastError = null;

        while (currentTry < maxRetries) {
          try {
            currentTry++;
            console.log(`Buy attempt ${currentTry}/${maxRetries} for group ${groupIndex + 1}`);

            const response = await fetch("https://pumpportal.fun/api/trade-local", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(buyTxArgs)
            });

            if (response.status !== 200) {
              throw new Error("Failed to get transaction: " + await response.text());
            }

            const transactions = await response.json();
            if (!Array.isArray(transactions) || transactions.length !== buyTxArgs.length) {
              throw new Error("Unexpected response. Expected exactly one transaction per wallet.");
            }

            // Sign each transaction with its corresponding wallet
            const encodedSignedTransactions = [];
            const signatures = [];

            for (let i = 0; i < transactions.length; i++) {
              const tx = VersionedTransaction.deserialize(new Uint8Array(bs58.decode(transactions[i])));
              tx.sign([walletGroup[i]]); // Sign with the corresponding wallet only
              encodedSignedTransactions.push(bs58.encode(tx.serialize()));
              signatures.push(bs58.encode(tx.signatures[0]));
            }

            // Send bundle to Jito
            const jitoResponse = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [encodedSignedTransactions]
              })
            });

            if (!jitoResponse.ok) {
              throw new Error("Jito bundle submission failed: " + await jitoResponse.text());
            }

            const jitoJson = await jitoResponse.json();
            if (!jitoJson.result) {
              throw new Error("Failed to get bundle_id from Jito response");
            }

            const buyStatus = await waitForBundleConfirmation(jitoJson.result);
            if (buyStatus === "confirmed" || buyStatus === "finalized") {
              console.log(`Buy bundle for group ${groupIndex + 1} confirmed/finalized!`);
              return { 
                groupIndex, 
                bundleId: jitoJson.result, 
                status: buyStatus,
                signatures 
              };
            }

            throw new Error(`Bundle status: ${buyStatus}`);

          } catch (error) {
            lastError = error;
            console.log(`Buy attempt ${currentTry} for group ${groupIndex + 1} failed: ${error.message}`);

            if (currentTry < maxRetries) {
              console.log("Waiting 1 second before next buy attempt...");
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        throw new Error(`All buy attempts failed for group ${groupIndex + 1}. Last error: ${lastError.message}`);
      } catch (error) {
        console.error(`Error processing wallet group ${groupIndex + 1}:`, error.message);
        throw error;
      }
    });

    try {
      const results = await Promise.all(buyPromises);
      console.log("All buy transactions completed successfully!");
      console.log("Results:", results);
      console.log("Mint address:", mintKeypair.publicKey.toBase58());
    } catch (error) {
      console.error("Error during parallel buy execution:", error);
      throw error;
    }

    rl.close();
  } catch (error) {
    console.error('Error in pre-production test:', error);
    rl.close();
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
} 