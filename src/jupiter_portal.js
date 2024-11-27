const { 
    Connection, 
    Keypair, 
    VersionedTransaction,
    TransactionMessage,
    ComputeBudgetProgram,
    PublicKey,
    AddressLookupTableProgram
} = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class JupiterPortalClient {
    constructor(config = {}) {
        this.connection = new Connection(
            config.rpcEndpoint || 'https://mainnet.helius-rpc.com/?api-key=63b3a69f-2586-470d-83ea-0267ce5248df',
            { commitment: 'confirmed' }
        );
        this.wallet = null;
        this.config = {
            slippageBps: config.slippageBps || 500,
            priorityFeeAmount: config.priorityFeeAmount || 1000000,
            maxSlippageBps: config.maxSlippageBps || 300,
            ...config
        };
    }

    async connect(privateKeyString) {
        try {
            if (!privateKeyString) {
                throw new Error('Private key is required');
            }

            // Decode the base58 private key
            const privateKeyBytes = bs58.decode(privateKeyString);
            
            // Create keypair from private key bytes
            const keypair = Keypair.fromSecretKey(privateKeyBytes);
            
            // Initialize wallet
            this.wallet = new Wallet(keypair);
            
            logger.info('Connected to Jupiter Portal');
            return true;
        } catch (error) {
            logger.error('Failed to connect to Jupiter Portal:', error);
            throw error;
        }
    }

    async getQuote(inputMint, outputMint, amount) {
        try {
            const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&restrictIntermediateTokens=true`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to get quote: ${response.statusText}`);
            }
            const quote = await response.json();
            return quote;
        } catch (error) {
            logger.error('Failed to get Jupiter quote:', error);
            throw error;
        }
    }

    async executeSwap(quote) {
        try {
            if (!this.wallet) {
                throw new Error('Wallet not initialized. Please call connect() first.');
            }

            // Generate swap transaction
            const swapTransaction = await this._getSwapTransaction(quote);
            
            // Sign and send transaction
            const txid = await this._sendTransaction(swapTransaction);
            
            logger.info(`Swap transaction sent: ${txid}`);
            return txid;
        } catch (error) {
            logger.error('Failed to execute Jupiter swap:', error);
            throw error;
        }
    }

    async _getSwapTransaction(quote) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        const url = 'https://quote-api.jup.ag/v6/swap';
        const body = {
            quoteResponse: quote,
            userPublicKey: this.wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicSlippage: {
                minBps: 50,
                maxBps: 300
            },
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: {
                priorityLevelWithMaxLamports: {
                    maxLamports: 20000000,
                    global: true,
                    priorityLevel: "veryHigh"
                }
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`Failed to get swap transaction: ${response.statusText}`);
        }

        return await response.json();
    }

    async _getWritableAccounts(transactionBase64) {
        try {
            const transactionBuffer = Buffer.from(transactionBase64, 'base64');
            const transaction = VersionedTransaction.deserialize(transactionBuffer);
            const writableAccounts = [];

            // Get all account keys
            const addressLookupTableAccounts = await this._resolveAddressLookupTables(transaction);
            const accountKeys = transaction.message.getAccountKeys({ addressLookupTableAccounts });

            // Find writable accounts
            for (let i = 0; i < accountKeys.length; i++) {
                if (transaction.message.isAccountWritable(i)) {
                    writableAccounts.push(accountKeys.get(i));
                }
            }

            return writableAccounts;
        } catch (error) {
            logger.warn('Error getting writable accounts:', error);
            return [];
        }
    }

    _calculatePriorityFeeLevels(priorityFees, writableAccounts) {
        if (!priorityFees || priorityFees.length === 0) {
            return {
                medium: 1000,
                high: 2000,
                veryHigh: 3000
            };
        }

        // Filter fees based on writable accounts if they exist
        let relevantFees = priorityFees;
        if (writableAccounts.length > 0) {
            relevantFees = priorityFees.filter(fee => 
                writableAccounts.some(account => 
                    fee.prioritizationFee > 0 && 
                    fee.accounts.includes(account.toString())
                )
            );
        }

        // If no relevant fees found, use all fees
        if (relevantFees.length === 0) {
            relevantFees = priorityFees;
        }

        // Sort fees by prioritization fee
        const sortedFees = relevantFees
            .map(x => x.prioritizationFee)
            .sort((a, b) => a - b);

        // Calculate percentiles
        const medium = sortedFees[Math.floor(sortedFees.length * 0.25)] || 1000;  // 25th percentile
        const high = sortedFees[Math.floor(sortedFees.length * 0.50)] || 2000;    // 50th percentile
        const veryHigh = sortedFees[Math.floor(sortedFees.length * 0.75)] || 3000; // 75th percentile

        return {
            medium: Math.max(medium, 1000),
            high: Math.max(high, 2000),
            veryHigh: Math.max(veryHigh, 3000)
        };
    }

    async _sendTransaction(swapTransaction) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        try {
            logger.info('Received swap transaction');

            // Deserialize the transaction
            const transactionBuffer = Buffer.from(swapTransaction.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(transactionBuffer);
            
            if (!transaction || !transaction.message) {
                throw new Error('Failed to deserialize transaction or message is undefined');
            }

            logger.info('Transaction deserialized successfully');

            // Fetch and resolve address lookup tables
            const addressLookupTableAccounts = await this._resolveAddressLookupTables(transaction);
            logger.info(`Resolved ${addressLookupTableAccounts.length} address lookup tables`);

            // Sign the transaction
            transaction.sign([this.wallet.payer]);
            logger.info('Transaction signed successfully');

            // Send and confirm transaction with retries
            const signature = await this._sendAndConfirmTransactionWithRetry(transaction);
            logger.info(`Transaction confirmed: ${signature}`);
            return signature;

        } catch (error) {
            logger.error('Failed to send transaction:', error);
            throw error;
        }
    }

    async _calculatePriorityFee(computeUnits, attempt) {
        try {
            // Get recent prioritization fees
            const priorityFees = await this.connection.getRecentPrioritizationFees();
            const feeLevels = this._calculatePriorityFeeLevels(priorityFees, []);

            // Select price based on attempt and add premium for each retry
            let selectedPrice;
            if (attempt === 1) {
                selectedPrice = feeLevels.high;
            } else if (attempt === 2) {
                selectedPrice = feeLevels.veryHigh;
            } else {
                selectedPrice = Math.floor(feeLevels.veryHigh * 1.5);
            }

            // Calculate total priority fee with higher cap
            const priorityFee = Math.min(selectedPrice * computeUnits, 20000000); // Cap at 0.02 SOL

            logger.info(`Priority fee calculation - Attempt ${attempt}:
                Compute Units: ${computeUnits}
                Medium Price (25th): ${feeLevels.medium} micro-lamports/CU
                High Price (50th): ${feeLevels.high} micro-lamports/CU
                Very High Price (75th): ${feeLevels.veryHigh} micro-lamports/CU
                Selected Price: ${selectedPrice} micro-lamports/CU
                Total Priority Fee: ${priorityFee} lamports`);

            return priorityFee;
        } catch (error) {
            logger.warn('Error calculating priority fee:', error);
            // Fallback to basic calculation with higher cap
            const basePrice = 1000 * Math.pow(2, attempt - 1);
            return Math.min(basePrice * computeUnits, 20000000);
        }
    }

    async _sendAndConfirmTransactionWithRetry(transaction, maxAttempts = 3) {
        let lastError;
        let signature;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Create a new transaction by deserializing the original
                const serializedTx = transaction.serialize();
                const currentTransaction = VersionedTransaction.deserialize(serializedTx);

                // Get fresh blockhash with finalized commitment
                const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');
                currentTransaction.message.recentBlockhash = blockhash;

                // Re-sign the transaction with the new blockhash
                currentTransaction.sign([this.wallet.payer]);

                // Serialize transaction for sending
                const serializedTransaction = currentTransaction.serialize();
                
                // Send and monitor transaction using Jupiter's recommended approach
                const controller = new AbortController();
                const abortSignal = controller.signal;

                try {
                    // Initial transaction send with retries
                    signature = await this.connection.sendRawTransaction(serializedTransaction, {
                        skipPreflight: true,
                        maxRetries: 2 // Add retries as recommended
                    });

                    logger.info(`Transaction sent with new blockhash, signature: ${signature}`);

                    // Start transaction resender
                    const abortableResender = async () => {
                        while (true) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            if (abortSignal.aborted) return;
                            try {
                                await this.connection.sendRawTransaction(serializedTransaction, {
                                    skipPreflight: true
                                });
                            } catch (e) {
                                logger.warn(`Failed to resend transaction: ${e}`);
                            }
                        }
                    };

                    // Start resender in background
                    abortableResender();

                    // Wait for confirmation
                    await this.connection.confirmTransaction({
                        signature,
                        blockhash,
                        lastValidBlockHeight,
                        abortSignal
                    }, 'confirmed');

                    // Transaction confirmed successfully
                    logger.info(`Transaction confirmed on attempt ${attempt}`);
                    controller.abort();
                    return signature;

                } catch (error) {
                    controller.abort();
                    if (error.message.includes('expired') || error.message.includes('block height exceeded')) {
                        throw new Error('Transaction expired, retrying with new blockhash');
                    }
                    throw error;
                }

            } catch (error) {
                lastError = error;
                logger.error(`Attempt ${attempt} failed:`, error);

                if (attempt === maxAttempts) {
                    throw new Error(`All ${maxAttempts} attempts failed. Last error: ${lastError.message}`);
                }

                // Adaptive backoff with shorter initial delays
                const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), 5000);
                logger.info(`Waiting ${delay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    async _resolveAddressLookupTables(transaction) {
        try {
            const lookupTableAddresses = transaction.message.addressTableLookups.map(
                lookup => lookup.accountKey
            );

            if (lookupTableAddresses.length === 0) {
                return [];
            }

            logger.info(`Fetching ${lookupTableAddresses.length} address lookup tables`);

            const addressLookupTableAccounts = await Promise.all(
                lookupTableAddresses.map(async (tableAddress) => {
                    const account = await this.connection.getAddressLookupTable(tableAddress)
                        .then(res => res.value);
                    if (!account) {
                        throw new Error(`Failed to fetch address lookup table ${tableAddress.toBase58()}`);
                    }
                    return account;
                })
            );

            return addressLookupTableAccounts;
        } catch (error) {
            logger.error('Error resolving address lookup tables:', error);
            throw error;
        }
    }

    async close() {
        // Cleanup if needed
        this.wallet = null;
        logger.info('Jupiter Portal closed');
    }
}

module.exports = JupiterPortalClient; 