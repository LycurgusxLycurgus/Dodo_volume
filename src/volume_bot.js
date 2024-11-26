const PumpPortalClient = require('./pump_portal');
const JupiterPortalClient = require('./jupiter_portal');
const logger = require('./logger');
const EventEmitter = require('events');

class VolumeBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Validate required configuration
        if (!config.privateKey) {
            throw new Error('Private key is required');
        }

        // Default RPC endpoint
        const defaultRpcEndpoint = 'https://api.mainnet-beta.solana.com';

        this.config = {
            targetVolume: config.targetVolume || 1000, // Target volume in USD
            minTradeSize: config.minTradeSize || 10,   // Minimum trade size in USD
            maxTradeSize: config.maxTradeSize || 100,  // Maximum trade size in USD
            tradeInterval: config.tradeInterval || 60000, // Time between trades in ms
            baseToken: config.baseToken || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mint address
            baseTokenDecimals: config.baseTokenDecimals || 6,
            privateKey: config.privateKey,
            platform: config.platform || 'jupiter', // Default to Jupiter
            publicKey: config.publicKey, // Required for PumpPortal
            rpcEndpoint: config.rpcEndpoint || defaultRpcEndpoint,
            ...config
        };

        // Initialize appropriate trading portal
        if (this.config.platform === 'pump') {
            this.pumpPortal = new PumpPortalClient({
                rpcEndpoint: this.config.rpcEndpoint || defaultRpcEndpoint
            });
            this.jupiterPortal = null;
        } else {
            this.pumpPortal = null;
            this.jupiterPortal = new JupiterPortalClient({
                rpcEndpoint: config.jupiter?.rpcEndpoint || this.config.rpcEndpoint,
                slippageBps: config.jupiter?.slippageBps || 50,
                priorityFeeAmount: config.jupiter?.priorityFeeAmount || 100000,
                maxSlippageBps: config.jupiter?.maxSlippageBps || 300
            });
        }

        // Trading state
        this.activeTokens = new Map(); // token address -> trading state
        this.isRunning = false;
    }

    async connect() {
        try {
            logger.info('Connecting to trading portals...');
            
            if (this.config.platform === 'pump') {
                await this.pumpPortal.connect();
            } else {
                await this.jupiterPortal.connect(this.config.privateKey);
            }

            logger.info('Successfully connected to trading portals');
            return true;
        } catch (error) {
            logger.error('Failed to connect:', error);
            throw error;
        }
    }

    async startVolumeBot(tokenAddress) {
        if (!this.isRunning) {
            this.isRunning = true;
            logger.info(`Starting volume bot for token ${tokenAddress}`);

            // Initialize token state
            this.activeTokens.set(tokenAddress, {
                currentVolume: 0,
                lastTradeTime: 0,
                trades: []
            });
            
            // Start volume management loop
            this._startVolumeManagement(tokenAddress);
        }
    }

    async _startVolumeManagement(tokenAddress) {
        const tokenState = this.activeTokens.get(tokenAddress);
        if (!tokenState) return;

        while (this.isRunning) {
            try {
                const volumeNeeded = this.config.targetVolume - tokenState.currentVolume;
                
                if (volumeNeeded > 0) {
                    await this._executeVolumeTrade(tokenAddress, volumeNeeded);
                }

                // Wait for next interval
                await new Promise(resolve => setTimeout(resolve, this.config.tradeInterval));
            } catch (error) {
                logger.error('Error in volume management:', error);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying
            }
        }
    }

    async _executeVolumeTrade(tokenAddress, volumeNeeded) {
        const tradeSize = this._calculateTradeSize(volumeNeeded);
        
        try {
            let txid;
            if (this.config.platform === 'pump') {
                if (!this.config.publicKey) {
                    throw new Error('Public key is required for PumpPortal trades');
                }

                // Execute trade using PumpPortal
                txid = await this.pumpPortal.executeTrade({
                    publicKey: this.config.publicKey,
                    action: "buy",
                    mint: tokenAddress,
                    denominatedInSol: "false",
                    amount: tradeSize * (10 ** this.config.baseTokenDecimals),
                    slippage: 10,
                    priorityFee: 0.00001,
                    pool: "pump"
                });
            } else {
                // Execute trade using Jupiter
                const quote = await this.jupiterPortal.getQuote(
                    this.config.baseToken,
                    tokenAddress,
                    tradeSize * (10 ** this.config.baseTokenDecimals)
                );
                txid = await this.jupiterPortal.executeSwap(quote);
            }

            logger.info(`Executed trade for ${tradeSize} USD, txid: ${txid}`);
            
            // Update volume tracking
            const tokenState = this.activeTokens.get(tokenAddress);
            tokenState.currentVolume += tradeSize;
            tokenState.lastTradeTime = Date.now();
            tokenState.trades.push({
                timestamp: Date.now(),
                volume: tradeSize,
                txid
            });

            return txid;
        } catch (error) {
            logger.error(`Failed to execute trade: ${error.message}`);
            throw error;
        }
    }

    _calculateTradeSize(volumeNeeded) {
        // Calculate a random trade size within configured bounds
        const minSize = Math.min(this.config.minTradeSize, volumeNeeded);
        const maxSize = Math.min(this.config.maxTradeSize, volumeNeeded);
        return minSize + Math.random() * (maxSize - minSize);
    }

    async stopVolumeBot(tokenAddress) {
        const tokenState = this.activeTokens.get(tokenAddress);
        if (tokenState) {
            this.isRunning = false;
            this.activeTokens.delete(tokenAddress);
            logger.info(`Stopped volume bot for ${tokenAddress}`);
        }
    }

    async close() {
        this.isRunning = false;
        for (const tokenAddress of this.activeTokens.keys()) {
            await this.stopVolumeBot(tokenAddress);
        }
        
        if (this.pumpPortal) {
            await this.pumpPortal.close();
        }
        if (this.jupiterPortal) {
            await this.jupiterPortal.close();
        }

        logger.info('Volume bot closed');
    }
}

module.exports = VolumeBot; 