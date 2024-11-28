require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { JitoJsonRpcClient } = require('jito-js-rpc');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class PumpPortalJitoSwapTester {
    constructor() {
        // Validate environment variables
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }
        if (!process.env.SOLANA_RPC_URL) {
            throw new Error('SOLANA_RPC_URL environment variable is required');
        }

        // Initialize connection and wallet
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.wallet = new Wallet(
            Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
        );

        // Initialize Jito client
        this.jitoClient = new JitoJsonRpcClient('https://mainnet.block-engine.jito.wtf/api/v1');

        // Constants
        this.TRADE_ENDPOINT = 'https://pumpportal.fun/api/trade-local';
        this.SOL_PRICE_USD = 230; // Approximate SOL price
        this.JITO_TIP_AMOUNT = 0.0005; // 0.0005 SOL as priority fee for Jito
    }

    async executeBundledTrade(tokenAddress, action, amountUSD = 0.03) {
        logger.info(`Preparing bundled ${action} transaction for ${amountUSD} USD of ${tokenAddress}`);
        
        // Convert USD to SOL (approximate)
        const amountSOL = amountUSD / this.SOL_PRICE_USD;
        
        // Create bundle parameters - we'll create two transactions in the bundle
        const bundledTxArgs = [
            {
                publicKey: this.wallet.publicKey.toString(),
                action: action,
                mint: tokenAddress,
                denominatedInSol: "true",
                amount: amountSOL.toFixed(9),
                slippage: 10,
                priorityFee: this.JITO_TIP_AMOUNT,
                pool: "pump"
            },
            {
                publicKey: this.wallet.publicKey.toString(),
                action: action,
                mint: tokenAddress,
                denominatedInSol: "true",
                amount: amountSOL.toFixed(9),
                slippage: 10,
                priorityFee: 0,
                pool: "pump"
            }
        ];

        logger.info('Requesting transactions from PumpPortal...');
        const response = await fetch(this.TRADE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bundledTxArgs)
        });

        if (response.status !== 200) {
            throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
        }

        const transactions = await response.json();
        let encodedSignedTransactions = [];
        let signatures = [];

        // Process each transaction
        for (let i = 0; i < bundledTxArgs.length; i++) {
            const tx = VersionedTransaction.deserialize(
                new Uint8Array(bs58.decode(transactions[i]))
            );
            
            // Simulate each transaction
            logger.info(`Simulating transaction ${i}...`);
            const { value: simulatedResponse } = await this.connection.simulateTransaction(
                tx,
                { replaceRecentBlockhash: true }
            );

            if (simulatedResponse.err) {
                logger.error(`Simulation failed for transaction ${i}:`, simulatedResponse);
                throw new Error(`Transaction simulation failed: ${JSON.stringify(simulatedResponse.err)}`);
            }

            tx.sign([this.wallet.payer]);
            encodedSignedTransactions.push(bs58.encode(tx.serialize()));
            signatures.push(bs58.encode(tx.signatures[0]));
        }

        logger.info('Sending bundle to Jito...');
        try {
            // Fix: Wrap encodedSignedTransactions in another array
            const bundleResponse = await this.jitoClient.sendBundle([encodedSignedTransactions]);
            logger.info('Bundle sent successfully:', bundleResponse);

            // Log transaction URLs
            signatures.forEach((sig, i) => {
                logger.info(`Transaction ${i}: https://solscan.io/tx/${sig}`);
            });

            return signatures;

        } catch (error) {
            logger.error('Failed to send bundle:', error);
            throw error;
        }
    }

    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting PumpPortal Jito Bundle Swap Test');
            logger.info('='.repeat(50));
            
            // Execute bundled buy
            logger.info(`Testing bundled buy of ${amountUSD} USD worth of token ${tokenAddress}`);
            const buySignatures = await this.executeBundledTrade(tokenAddress, 'buy', amountUSD);
            
            // Wait before selling
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Execute bundled sell
            logger.info(`Testing bundled sell of ${amountUSD} USD worth of token ${tokenAddress}`);
            const sellSignatures = await this.executeBundledTrade(tokenAddress, 'sell', amountUSD);
            
            logger.info('='.repeat(50));
            logger.info('Swap Test Results:');
            logger.info(`Amount per transaction: ${amountUSD} USD`);
            logger.info('Buy Transactions:');
            buySignatures.forEach((sig, i) => {
                logger.info(`  ${i + 1}: https://solscan.io/tx/${sig}`);
            });
            logger.info('Sell Transactions:');
            sellSignatures.forEach((sig, i) => {
                logger.info(`  ${i + 1}: https://solscan.io/tx/${sig}`);
            });
            logger.info('='.repeat(50));

            return { buySignatures, sellSignatures };

        } catch (error) {
            logger.error('Swap test failed:', error);
            throw error;
        }
    }
}

// Run if called directly
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node test_pump_portal_jito_swap.js <token_address> [amount_usd]');
        process.exit(1);
    }

    const [tokenAddress, amountUSD] = args;
    const tester = new PumpPortalJitoSwapTester();
    tester.testSwap(tokenAddress, parseFloat(amountUSD) || 0.03)
        .catch(error => {
            console.error('Test failed:', error);
            process.exit(1);
        });
}

module.exports = PumpPortalJitoSwapTester; 