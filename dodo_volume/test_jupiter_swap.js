require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class JupiterSwapTester {
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
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_DECIMALS = 6;
    }

    async getQuote(inputMint, outputMint, amount) {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
        
        logger.info(`Fetching quote from: ${url}`);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to get quote: ${response.statusText}`);
        }

        const data = await response.json();
        logger.info('Quote received:', data);
        return data;
    }

    async executeSwap(quoteResponse) {
        logger.info('Preparing swap transaction...');
        
        const { swapTransaction, lastValidBlockHeight } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicSlippage: { maxBps: 300 },
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        priorityLevelWithMaxLamports: {
                            maxLamports: 10000000,
                            priorityLevel: "veryHigh"
                        }
                    }
                }),
            })
        ).json();

        logger.info('Deserializing transaction...');
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(swapTransaction, 'base64')
        );

        logger.info('Signing transaction...');
        transaction.sign([this.wallet.payer]);

        // Get signature for logging
        const signature = bs58.encode(transaction.signatures[0]);
        
        // Simulate transaction first
        logger.info('Simulating transaction...');
        const { value: simulatedResponse } = await this.connection.simulateTransaction(
            transaction,
            { replaceRecentBlockhash: true, commitment: 'processed' }
        );

        if (simulatedResponse.err) {
            logger.error('Simulation failed:', simulatedResponse);
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulatedResponse.err)}`);
        }

        logger.info('Simulation successful, sending transaction...');
        
        // Use the blockhash from the transaction message
        const blockhash = transaction.message.recentBlockhash;
        const serializedTransaction = transaction.serialize();

        // Send with retries
        let retries = 3;
        while (retries > 0) {
            try {
                const txid = await this.connection.sendRawTransaction(
                    serializedTransaction,
                    {
                        skipPreflight: true,
                        maxRetries: 3,
                        preflightCommitment: 'processed'
                    }
                );

                logger.info(`Transaction sent: ${txid}`);

                // Wait for confirmation with proper blockhash
                const confirmation = await this.connection.confirmTransaction({
                    signature: txid,
                    blockhash: blockhash,
                    lastValidBlockHeight: lastValidBlockHeight
                }, 'confirmed');

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
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

    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting Jupiter Swap Test');
            logger.info('='.repeat(50));
            
            // Convert USD amount to USDC units (6 decimals)
            const amount = Math.floor(amountUSD * Math.pow(10, this.USDC_DECIMALS));
            
            logger.info(`Testing swap of ${amountUSD} USD to token ${tokenAddress}`);
            
            // Get quote
            const quote = await this.getQuote(
                this.SOL_MINT,
                tokenAddress,
                amount
            );

            // Execute swap
            const txid = await this.executeSwap(quote);
            
            logger.info('='.repeat(50));
            logger.info('Swap Test Results:');
            logger.info(`Amount: ${amountUSD} USD`);
            logger.info(`Transaction ID: ${txid}`);
            logger.info(`Explorer URL: https://solscan.io/tx/${txid}`);
            logger.info('='.repeat(50));

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
        console.error('Usage: node test_jupiter_swap.js <token_address> [amount_usd]');
        process.exit(1);
    }

    const [tokenAddress, amountUSD] = args;
    const tester = new JupiterSwapTester();
    tester.testSwap(tokenAddress, parseFloat(amountUSD) || 0.1)
        .catch(error => {
            console.error('Test failed:', error);
            process.exit(1);
        });
}

module.exports = JupiterSwapTester; 