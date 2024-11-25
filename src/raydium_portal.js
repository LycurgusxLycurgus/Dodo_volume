const { Raydium } = require('@raydium-io/raydium-sdk-v2');
const { Connection, PublicKey, clusterApiUrl, Keypair } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const EventEmitter = require('events');
const logger = require('./logger');

// Metaplex Token Metadata Program ID
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Rate limiting configuration for public RPC
const RATE_LIMIT = {
    MAX_REQUESTS_PER_10_SEC: 10, // Drastically reduced
    WINDOW_MS: 10000,
    RETRY_DELAY_MS: 3000, // Increased base delay
    MAX_RETRIES: 2,
    CONCURRENT_LIMIT: 1, // Only allow one request at a time
    REQUEST_DELAY: 2000 // Force delay between requests
};

// Simplified request queue
class SimpleRequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async add(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            if (!this.processing) {
                this.processNext();
            }
        });
    }

    async processNext() {
        if (this.queue.length === 0) {
            this.processing = false;
            return;
        }

        this.processing = true;
        const { operation, resolve, reject } = this.queue.shift();

        try {
            // Force delay between requests
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.REQUEST_DELAY));
            const result = await operation();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            // Process next item after delay
            setTimeout(() => this.processNext(), RATE_LIMIT.REQUEST_DELAY);
        }
    }
}

class RaydiumPortalClient extends EventEmitter {
    constructor(config = {}) {
        super();
        this.connection = new Connection(
            config.rpcUrl || clusterApiUrl('mainnet-beta'),
            {
                commitment: 'confirmed',
                wsEndpoint: config.wsEndpoint || 'wss://api.mainnet-beta.solana.com',
                confirmTransactionInitialTimeout: 60000,
                maxSupportedTransactionVersion: 0
            }
        );
        this.owner = Keypair.generate();
        this.raydium = null;
        this.isConnected = false;
        this.subscriptions = new Map();
        this.tokenList = null;
        this.knownMints = new Set();
        this.requestCount = 0;
        this.windowStart = Date.now();
        this.requestQueue = new SimpleRequestQueue();
        this.processingTokens = new Set();
        this.lastProcessedTime = Date.now();
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async rateLimit() {
        const now = Date.now();
        if (now - this.windowStart >= RATE_LIMIT.WINDOW_MS) {
            this.requestCount = 0;
            this.windowStart = now;
        }

        if (this.requestCount >= RATE_LIMIT.MAX_REQUESTS_PER_10_SEC) {
            const waitTime = Math.max(
                RATE_LIMIT.WINDOW_MS - (now - this.windowStart),
                RATE_LIMIT.RETRY_DELAY_MS
            );
            logger.debug(`Rate limit reached. Waiting ${waitTime}ms before next request...`);
            await this.sleep(waitTime);
            this.requestCount = 0;
            this.windowStart = Date.now();
        }
        this.requestCount++;
    }

    async retryWithBackoff(operation) {
        try {
            return await operation();
        } catch (error) {
            if (error.message.includes('429')) {
                logger.debug('Rate limit hit, waiting before retry...');
                await this.sleep(RATE_LIMIT.RETRY_DELAY_MS);
                return await operation();
            }
            throw error;
        }
    }

    async getTokenMetadata(mintAddress) {
        try {
            const [metadataAddress] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('metadata'),
                    METADATA_PROGRAM_ID.toBuffer(),
                    new PublicKey(mintAddress).toBuffer(),
                ],
                METADATA_PROGRAM_ID
            );

            const accountInfo = await this.retryWithBackoff(async () => 
                this.connection.getAccountInfo(metadataAddress)
            );

            if (!accountInfo) return null;

            // Decode metadata
            const metadata = this.decodeMetadata(accountInfo.data);
            return metadata;
        } catch (error) {
            logger.debug(`No metadata found for token ${mintAddress}`);
            return null;
        }
    }

    decodeMetadata(buffer) {
        try {
            // Skip the metadata prefix (first 1 byte)
            let offset = 1;
            
            // Read name length and name
            const nameLength = buffer[offset];
            offset += 1;
            const name = buffer.slice(offset, offset + nameLength)
                .toString('utf8')
                .replace(/\u0000/g, '') // Remove null characters
                .trim();
            offset += nameLength;
            
            // Read symbol length and symbol
            const symbolLength = buffer[offset];
            offset += 1;
            const symbol = buffer.slice(offset, offset + symbolLength)
                .toString('utf8')
                .replace(/\u0000/g, '') // Remove null characters
                .trim();
            
            // Only return if we have valid strings
            if (this.isValidString(name) && this.isValidString(symbol)) {
                return { name, symbol };
            }
            return null;
        } catch (error) {
            logger.debug('Error decoding metadata:', error);
            return null;
        }
    }

    isValidString(str) {
        // Check if string contains only printable ASCII characters and common Unicode
        return typeof str === 'string' && 
               str.length > 0 && 
               /^[\x20-\x7E\u00A0-\u00FF\u0100-\u017F\u0180-\u024F\u0300-\u036F]*$/.test(str);
    }

    async connect() {
        try {
            await this.retryWithBackoff(async () => {
                this.raydium = await Raydium.load({
                    connection: this.connection,
                    owner: this.owner.publicKey,
                    disableLoadToken: false
                });

                const tokenData = await this.raydium.api.getTokenList();
                this.tokenList = tokenData.mintList;
                this.knownMints = new Set(this.tokenList.map(token => token.mint));
            });

            this.isConnected = true;
            logger.info('Connected to Raydium');
            logger.info(`Loaded ${this.tokenList.length} known tokens for reference`);
            this.emit('connected');
            return true;
        } catch (error) {
            logger.error('Failed to connect to Raydium:', error);
            return false;
        }
    }

    async monitorNewTokens(callback) {
        if (!this.isConnected) {
            throw new Error('Not connected to Raydium');
        }

        logger.info(`Currently monitoring Solana blockchain for new token mints...`);
        
        const tokenProgramSubscription = this.connection.onLogs(
            TOKEN_PROGRAM_ID,
            async (logs) => {
                try {
                    for (const log of logs.logs) {
                        if (log.includes('Instruction: InitializeMint') || log.includes('Instruction: CreateMint')) {
                            await this.processNewToken(logs, callback);
                        }
                    }
                } catch (error) {
                    if (!error.message.includes('429')) {
                        logger.error('Error processing token program logs:', error);
                    }
                }
            },
            'confirmed'
        );

        this.subscriptions.set('new_tokens', tokenProgramSubscription);
        logger.info('Token mint monitoring started successfully');
    }

    async processNewToken(logs, callback) {
        const signature = logs.signature;
        
        await this.requestQueue.add(async () => {
            try {
                const tx = await this.retryWithBackoff(async () => 
                    this.connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    })
                );

                if (!tx?.meta?.postTokenBalances) return;

                for (const postBalance of tx.meta.postTokenBalances) {
                    const mintAddress = postBalance.mint;
                    
                    if (this.knownMints.has(mintAddress)) continue;
                    
                    // Get basic token info first
                    const mintInfo = await this.retryWithBackoff(async () => 
                        this.connection.getParsedAccountInfo(new PublicKey(mintAddress))
                    );

                    if (!mintInfo.value?.data?.parsed?.info) continue;

                    const mintData = mintInfo.value.data.parsed.info;
                    this.knownMints.add(mintAddress);

                    // Simplified token info
                    let tokenInfo = {
                        mint: mintAddress,
                        decimals: mintData.decimals,
                        symbol: 'UNKNOWN',
                        name: 'Unknown Token'
                    };

                    // Try to get Raydium info with single retry
                    try {
                        const raydiumTokenInfo = await this.retryWithBackoff(async () =>
                            this.raydium.api.getTokenInfo([mintAddress])
                        );
                        if (raydiumTokenInfo?.[0]) {
                            tokenInfo = raydiumTokenInfo[0];
                        }
                    } catch (e) {
                        // Use default token info if Raydium fails
                    }

                    callback({
                        type: 'new_token',
                        token: tokenInfo,
                        mintInfo: mintData,
                        signature: signature
                    });

                    logger.info(`New token mint detected: ${mintAddress}`);
                    logger.info(`Name: ${tokenInfo.name}, Symbol: ${tokenInfo.symbol}`);
                    logger.info(`Decimals: ${mintData.decimals}, Supply: ${mintData.supply || 'Unknown'}`);
                }
            } catch (error) {
                logger.debug(`Error processing transaction ${signature}:`, error);
            }
        });
    }

    async monitorTokenTransactions(tokenMintAddress, callback) {
        if (!this.isConnected) {
            throw new Error('Not connected to Raydium');
        }

        if (!this.isValidSolanaAddress(tokenMintAddress)) {
            throw new Error(`Invalid Solana token address format. Address should be a base58 encoded string, e.g., 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' (USDC)`);
        }

        try {
            const tokenInfo = await this.raydium.api.getTokenInfo([tokenMintAddress]);
            if (!tokenInfo || tokenInfo.length === 0) {
                throw new Error(`Token ${tokenMintAddress} not found in Raydium`);
            }
            
            logger.info(`Found token: ${tokenInfo[0].symbol || 'Unknown'} (${tokenMintAddress})`);
            
            const mintPubkey = new PublicKey(tokenMintAddress);
            const id = this.connection.onLogs(
                mintPubkey,
                (logs, context) => {
                    callback({
                        type: 'token_transaction',
                        token: tokenInfo[0],
                        logs,
                        context,
                        tokenMint: tokenMintAddress
                    });
                },
                'confirmed'
            );

            this.subscriptions.set(`token_${tokenMintAddress}`, id);
            logger.info(`Successfully started monitoring transactions for ${tokenInfo[0].symbol || tokenMintAddress}`);
        } catch (error) {
            logger.error(`Error monitoring token ${tokenMintAddress}:`, error);
            throw error;
        }
    }

    isValidSolanaAddress(address) {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    async monitorAccountTransactions(accountAddress, callback) {
        if (!this.isConnected) {
            throw new Error('Not connected to Raydium');
        }

        if (!this.isValidSolanaAddress(accountAddress)) {
            throw new Error(`Invalid Solana account address format. Address should be a base58 encoded string.`);
        }

        try {
            const accountPubkey = new PublicKey(accountAddress);
            const id = this.connection.onLogs(
                accountPubkey,
                (logs, context) => {
                    callback({
                        type: 'account_transaction',
                        logs,
                        context,
                        account: accountAddress
                    });
                },
                'confirmed'
            );

            this.subscriptions.set(`account_${accountAddress}`, id);
            logger.info(`Successfully started monitoring transactions for account ${accountAddress}`);
        } catch (error) {
            logger.error(`Error monitoring account ${accountAddress}:`, error);
            throw error;
        }
    }

    async stopMonitoring(type, address) {
        const key = address ? `${type}_${address}` : type;
        const subscription = this.subscriptions.get(key);
        
        if (subscription) {
            await this.connection.removeOnLogsListener(subscription);
            this.subscriptions.delete(key);
            logger.info(`Stopped monitoring ${key}`);
        }
    }

    async close() {
        for (const [key, subscription] of this.subscriptions.entries()) {
            await this.connection.removeOnLogsListener(subscription);
        }
        this.subscriptions.clear();
        this.isConnected = false;
        logger.info('Closed all connections and subscriptions');
    }
}

module.exports = RaydiumPortalClient; 