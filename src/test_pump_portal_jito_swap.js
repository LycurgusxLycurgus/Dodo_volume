require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { JitoJsonRpcClient } = require('jito-js-rpc');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');
const axios = require('axios');

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

        // Add new constants for dynamic parameters
        this.HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
        this.PRICE_CACHE_DURATION = 30000; // 30 seconds
        this.lastPriceUpdate = 0;
        this.cachedSolPrice = null;

        // Update Helius endpoint constant
        this.HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${this.HELIUS_API_KEY}`;
    }

    async getSolPriceUSD() {
        // Return cached price if still valid
        if (this.cachedSolPrice && (Date.now() - this.lastPriceUpdate) < this.PRICE_CACHE_DURATION) {
            return this.cachedSolPrice;
        }

        try {
            const response = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
            );
            this.cachedSolPrice = response.data.solana.usd;
            this.lastPriceUpdate = Date.now();
            return this.cachedSolPrice;
        } catch (error) {
            logger.error('Failed to fetch SOL price:', error);
            return this.SOL_PRICE_USD; // Fallback to default price
        }
    }

    async getRecommendedPriorityFee() {
        try {
            const PRIORITY_LEVELS = {
                MIN: 'Min',
                LOW: 'Low',
                MEDIUM: 'Medium',
                HIGH: 'High',
                VERY_HIGH: 'VeryHigh',
                UNSAFE_MAX: 'UnsafeMax',
                DEFAULT: 'Default'
            };

            const payload = {
                jsonrpc: "2.0",
                id: "helius-priority-fee",
                method: "getPriorityFeeEstimate",
                params: [{
                    accountKeys: [this.wallet.publicKey.toString()],
                    options: {
                        priorityLevel: PRIORITY_LEVELS.HIGH,
                        includeAllPriorityFeeLevels: false
                    }
                }]
            };

            logger.info('Sending priority fee request to Helius...');
            const response = await axios.post(this.HELIUS_RPC_URL, payload);
            
            if (response.data?.result?.priorityFeeEstimate) {
                // Convert from lamports to SOL and add 20% margin for safety
                const recommendedFee = (response.data.result.priorityFeeEstimate / 1e9) * 1.2;
                logger.info(`Recommended priority fee: ${recommendedFee} SOL`);
                
                // Ensure we return a number and use a minimum threshold
                const finalFee = Math.max(recommendedFee, 0.0001); // Minimum 0.0001 SOL
                logger.info(`Using priority fee: ${finalFee} SOL`);
                return finalFee;
            }
            
            logger.warn('Using fallback priority fee due to invalid response');
            return this.JITO_TIP_AMOUNT;

        } catch (error) {
            logger.error('Failed to fetch priority fee, using fallback:', error.message);
            return this.JITO_TIP_AMOUNT;
        }
    }

    calculateDynamicSlippage() {
        // Start with base slippage of 1%
        const baseSlippage = 1;
        
        // Get current hour
        const hour = new Date().getUTCHours();
        
        // Increase slippage during typically volatile hours (around market opens)
        if (hour >= 13 && hour <= 15) { // Around US market open
            return baseSlippage * 1.5;
        } else if (hour >= 2 && hour <= 4) { // Around Asian market open
            return baseSlippage * 1.3;
        }
        
        return baseSlippage;
    }

    async executeBundledTrade(tokenAddress, action, amountUSD = 0.03) {
        logger.info(`Preparing bundled ${action} transaction for ${amountUSD} USD of ${tokenAddress}`);
        
        // Get dynamic parameters
        const solPrice = await this.getSolPriceUSD();
        const priorityFee = await this.getRecommendedPriorityFee();
        const dynamicSlippage = this.calculateDynamicSlippage();
        
        logger.info(`Using dynamic values:`, {
            solPrice: `$${solPrice}`,
            priorityFee: `${priorityFee} SOL`,
            slippage: `${dynamicSlippage}%`
        });
        
        // Convert USD to SOL using current price
        const amountSOL = amountUSD / solPrice;
        
        // Create bundle parameters with dynamic values
        const bundledTxArgs = [
            {
                publicKey: this.wallet.publicKey.toString(),
                action: action,
                mint: tokenAddress,
                denominatedInSol: "true",
                amount: amountSOL.toFixed(9),
                slippage: dynamicSlippage,
                priorityFee: priorityFee, // Using dynamic priority fee
                pool: "pump"
            },
            {
                publicKey: this.wallet.publicKey.toString(),
                action: action,
                mint: tokenAddress,
                denominatedInSol: "true",
                amount: amountSOL.toFixed(9),
                slippage: dynamicSlippage,
                priorityFee: 0, // Second transaction in bundle doesn't need priority fee
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