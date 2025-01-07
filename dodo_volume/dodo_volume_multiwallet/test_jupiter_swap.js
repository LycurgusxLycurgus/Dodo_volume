require('dotenv').config();
const { 
  Connection, 
  Keypair, 
  VersionedTransaction, 
  LAMPORTS_PER_SOL 
} = require('@solana/web3.js');
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

    async getQuote(inputMint, outputMint, amount, slippageBps = 50) {
        try {
            // Ensure amount is an integer
            const amountStr = Math.floor(amount).toString();
            const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=${slippageBps}`;
            
            logger.info(`Fetching quote from: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to get quote: ${response.statusText}`);
            }

            const data = await response.json();
            logger.info(`Quote received: ${JSON.stringify(data)}`);
            return data;
        } catch (error) {
            logger.error(`Error getting quote: ${error.message}`);
            throw error;
        }
    }

    async executeSwap(quoteResponse) {
        logger.info('Preparing swap transaction...');
        
        const swapApiResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
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
        });

        const { swapTransaction, lastValidBlockHeight } = await swapApiResponse.json();
        if (!swapTransaction) {
            throw new Error('Failed to get a valid swapTransaction from Jupiter API');
        }

        logger.info('Deserializing transaction...');
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(swapTransaction, 'base64')
        );

        logger.info('Signing transaction...');
        transaction.sign([this.wallet.payer]);

        // Just for logging reference:
        const signatureForLog = bs58.encode(transaction.signatures[0]);

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

                // Wait for confirmation
                const confirmation = await this.connection.confirmTransaction({
                    signature: txid,
                    blockhash: blockhash,
                    lastValidBlockHeight: lastValidBlockHeight
                }, 'confirmed');

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
                }

                logger.info(`Transaction confirmed successfully: ${txid}`);
                logger.info(`Transaction URL: https://solscan.io/tx/${txid}`);
                return txid;
            } catch (error) {
                retries--;
                logger.warn(`Transaction attempt failed: ${error.message}. Retries left: ${retries}`);
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    /**
     * testSwap
     * 
     * @param {String} outputMint - Mint address of the token you want to receive
     * @param {Number} amount - If inputMint is SOL, this is in SOL units. If inputMint is a token, this is the token's decimal units.
     * @param {String} inputMint - Mint address of the token you will spend (defaults to SOL mint)
     * @param {Object} options - optional arguments like swapMode
     */
    async testSwap(
        outputMint, 
        amount, 
        inputMint = 'So11111111111111111111111111111111111111112', 
        options = {}
    ) {
        try {
            // Determine if we are selling or buying
            const isSell = inputMint !== this.SOL_MINT; 
            // If we're selling a token, 'amount' is already in token units
            // If we're buying a token (input is SOL), convert 'amount' (in SOL) to lamports
            const amountToUse = isSell 
                ? Math.floor(amount) 
                : Math.floor(amount * LAMPORTS_PER_SOL);

            // Get quote
            const quote = await this.getQuote(inputMint, outputMint, amountToUse, 50);

            // Execute swap
            const txid = await this.executeSwap(quote);
            return txid;
        } catch (error) {
            logger.error(`Swap test failed: ${error.message}`, { 
                stack: error.stack
            });
            throw error;
        }
    }
}

// Run if called directly
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        if (args.length < 1) {
            console.error('Usage: node test_jupiter_swap.js <token_address> [amount]');
            process.exit(1);
        }

        const [tokenAddress, amount] = args;
        const tester = new JupiterSwapTester();
        try {
            // Default to 0.03 if not specified
            const finalAmount = parseFloat(amount) || 0.03;
            logger.info(`Running testSwap with tokenAddress=${tokenAddress}, amount=${finalAmount} SOL or token units`);
            await tester.testSwap(tokenAddress, finalAmount);
        } catch (error) {
            console.error('Test failed:', error);
            process.exit(1);
        }
    })();
}

module.exports = JupiterSwapTester;
