const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class JupiterPortalClient {
    constructor(config = {}) {
        this.connection = new Connection(config.rpcEndpoint || 'https://api.mainnet-beta.solana.com');
        this.wallet = null;
        this.config = {
            slippageBps: config.slippageBps || 50,
            priorityFeeAmount: config.priorityFeeAmount || 100000,
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
                maxBps: this.config.maxSlippageBps,
            },
            prioritizationFee: {
                amount: this.config.priorityFeeAmount,
            },
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

    async _sendTransaction(swapTransaction) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        const transactionBuffer = Buffer.from(swapTransaction.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(transactionBuffer);
        transaction.sign([this.wallet.payer]);

        const rawTransaction = transaction.serialize();
        return await this.connection.sendTransaction(rawTransaction, {
            skipPreflight: true,
        });
    }

    async close() {
        // Cleanup if needed
        this.wallet = null;
        logger.info('Jupiter Portal closed');
    }
}

module.exports = JupiterPortalClient; 