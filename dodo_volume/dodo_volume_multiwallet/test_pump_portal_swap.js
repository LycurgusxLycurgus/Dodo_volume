require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class PumpPortalSwapTester {
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

        // Constants
        this.TRADE_ENDPOINT = 'https://pumpportal.fun/api/trade-local';
        this.SOL_PRICE_USD = 230; // Approximate SOL price, you might want to fetch this dynamically

        // Add default priority fee
        this.priorityFee = 0.001;
    }

    // Add setter for priority fee
    setPriorityFee(fee) {
        this.priorityFee = fee;
    }

    async executeTrade(tokenAddress, action, amountUSD = 0.03) {
        logger.info(`Preparing ${action} transaction for ${amountUSD} USD of ${tokenAddress}`);
        
        // Convert USD to SOL (approximate)
        const amountSOL = amountUSD / this.SOL_PRICE_USD;
        
        const tradeParams = {
            publicKey: this.wallet.publicKey.toString(),
            action: action,
            mint: tokenAddress,
            amount: amountSOL.toFixed(9),
            denominatedInSol: "true",
            slippage: 10,
            priorityFee: this.priorityFee,  // Use configured priority fee
            pool: "pump"
        };

        logger.info('Trade parameters:', tradeParams);

        // Get transaction from PumpPortal
        const response = await fetch(this.TRADE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tradeParams)
        });

        if (!response.ok) {
            throw new Error(`Failed to get transaction: ${response.statusText}`);
        }

        const txBytes = await response.arrayBuffer();
        logger.info('Deserializing transaction...');
        
        const transaction = VersionedTransaction.deserialize(
            new Uint8Array(txBytes)
        );

        logger.info('Signing transaction...');
        transaction.sign([this.wallet.payer]);

        // Simulate transaction first
        logger.info('Simulating transaction...');
        const { value: simulatedResponse } = await this.connection.simulateTransaction(
            transaction,
            { replaceRecentBlockhash: true }
        );

        if (simulatedResponse.err) {
            logger.error('Simulation failed:', simulatedResponse);
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulatedResponse.err)}`);
        }

        logger.info('Simulation successful, sending transaction...');

        // Send with retries
        let retries = 3;
        while (retries > 0) {
            try {
                const txid = await this.connection.sendTransaction(transaction, {
                    skipPreflight: true,
                    maxRetries: 3,
                    preflightCommitment: 'processed'
                });

                logger.info(`Transaction sent: ${txid}`);

                // Use new confirmation method
                const confirmed = await this._confirmPumpTransaction(txid);
                if (!confirmed) {
                    throw new Error('Transaction confirmation failed');
                }

                logger.info('Transaction confirmed successfully');
                logger.info(`Transaction URL: https://solscan.io/tx/${txid}`);
                return txid;

            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                
                logger.warn(`Transaction attempt failed, retrying... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    // Add new confirmation method specifically for PumpPortal
    async _confirmPumpTransaction(signature, maxAttempts = 60) {
        const startTime = Date.now();
        const timeoutMs = 60000; // 1 minute timeout
        let attempt = 0;

        while (Date.now() - startTime < timeoutMs && attempt < maxAttempts) {
            try {
                attempt++;
                const status = await this.connection.getSignatureStatus(signature);
                
                // Check for errors
                if (status?.value?.err) {
                    logger.error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                    return false;
                }

                // Check confirmation status
                if (status?.value?.confirmationStatus === 'confirmed' || 
                    status?.value?.confirmationStatus === 'finalized') {
                    return true;
                }

                // If not confirmed yet, wait before next attempt
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                // Handle rate limiting
                if (error.message.includes('429')) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                logger.warn(`Confirmation check failed: ${error.message}`);
                // Wait longer between retries
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // If we get here, we've timed out
        throw new Error(`Transaction was not confirmed in ${timeoutMs/1000} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`);
    }

    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting PumpPortal Swap Test');
            logger.info('='.repeat(50));
            
            // Execute buy
            logger.info(`Testing buy of ${amountUSD} USD worth of token ${tokenAddress}`);
            const buyTxid = await this.executeTrade(tokenAddress, 'buy', amountUSD);
            
            // Wait a bit before selling
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Execute sell
            logger.info(`Testing sell of ${amountUSD} USD worth of token ${tokenAddress}`);
            const sellTxid = await this.executeTrade(tokenAddress, 'sell', amountUSD);
            
            logger.info('='.repeat(50));
            logger.info('Swap Test Results:');
            logger.info(`Amount: ${amountUSD} USD`);
            logger.info(`Buy Transaction: https://solscan.io/tx/${buyTxid}`);
            logger.info(`Sell Transaction: https://solscan.io/tx/${sellTxid}`);
            logger.info('='.repeat(50));

            return { buyTxid, sellTxid };

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
        console.error('Usage: node test_pump_portal_swap.js <token_address> [amount_usd]');
        process.exit(1);
    }

    const [tokenAddress, amountUSD] = args;
    const tester = new PumpPortalSwapTester();
    tester.testSwap(tokenAddress, parseFloat(amountUSD) || 0.03)
        .catch(error => {
            console.error('Test failed:', error);
            process.exit(1);
        });
}

module.exports = PumpPortalSwapTester; 