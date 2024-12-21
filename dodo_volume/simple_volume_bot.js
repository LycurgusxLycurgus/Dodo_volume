const PumpPortalSwapTester = require('./test_pump_portal_swap');
const JupiterSwapTester = require('./test_jupiter_swap');
const logger = require('./logger');
const EventEmitter = require('events');

class SimpleVolumeBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        if (!config.privateKey) {
            throw new Error('Private key is required');
        }

        this.config = {
            privateKey: config.privateKey,
            rpcEndpoint: config.rpcEndpoint || process.env.SOLANA_RPC_URL,
            slippageBps: 100, // 10% slippage
            priorityFee: config.priorityFee || 0.001, // Updated to 0.001 SOL default
            tradeAmountUSD: config.tradeAmountUSD || 0.01,
            minInterval: 15000, // 15 seconds minimum between trades
            maxInterval: 45000, // 45 seconds maximum between trades
        };

        this.stats = {
            successfulTrades: 0,
            totalTrades: 0,
            startTime: null,
            endTime: null
        };

        this.isRunning = false;
        this.pumpTester = new PumpPortalSwapTester();
        this.jupiterTester = new JupiterSwapTester();
    }

    async promptForTokenType() {
        // Note: In a real implementation, this would be handled by the frontend
        return new Promise(resolve => {
            logger.info('Please specify the token type:');
            logger.info('1. PumpFun (Bonding Curve)');
            logger.info('2. Raydium/Jupiter');
            // Frontend would handle this input
            resolve('pump'); // or 'jupiter'
        });
    }

    async promptForDuration() {
        // Note: In a real implementation, this would be handled by the frontend
        return new Promise(resolve => {
            logger.info('Please select duration:');
            logger.info('1. 5 minutes');
            logger.info('2. 1 hour');
            logger.info('3. 4 hours');
            // Frontend would handle this input
            resolve(5 * 60 * 1000); // Duration in milliseconds
        });
    }

    async start(tokenAddress, duration, tokenType) {
        if (this.isRunning) {
            throw new Error('Bot is already running');
        }

        this.isRunning = true;
        this.stats.startTime = Date.now();
        this.stats.endTime = this.stats.startTime + duration;

        logger.info('Starting SimpleVolumeBot with configuration:');
        logger.info(`- Token Address: ${tokenAddress}`);
        logger.info(`- Platform: ${tokenType}`);
        logger.info(`- Trade Amount: $${this.config.tradeAmountUSD}`);
        logger.info(`- Slippage: 10%`);
        logger.info(`- Priority Fee: Medium`);
        logger.info(`- Trade Interval: Random 15-45 seconds`);
        logger.info(`- Duration: ${duration / 1000 / 60} minutes`);

        while (this.isRunning && Date.now() < this.stats.endTime) {
            try {
                await this._executeTradeCycle(tokenAddress, tokenType);
                
                // Update and emit stats
                this._emitStatus();
                
                // Random delay between trades
                const delay = Math.floor(
                    Math.random() * (this.config.maxInterval - this.config.minInterval) 
                    + this.config.minInterval
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (error) {
                logger.error('Error executing trade cycle:', error);
                this.stats.totalTrades++;
                this._emitStatus();
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        this.isRunning = false;
        logger.info('Bot finished running');
        return this.stats;
    }

    async _executeTradeCycle(tokenAddress, tokenType) {
        this.stats.totalTrades++;
        
        try {
            if (tokenType === 'pump') {
                await this.pumpTester.testSwap(
                    tokenAddress, 
                    this.config.tradeAmountUSD
                );
            } else {
                await this.jupiterTester.testSwap(
                    tokenAddress, 
                    this.config.tradeAmountUSD
                );
            }
            
            this.stats.successfulTrades++;
            return true;
        } catch (error) {
            logger.error(`Trade cycle failed: ${error.message}`);
            return false;
        }
    }

    _emitStatus() {
        const remainingTime = Math.max(0, this.stats.endTime - Date.now());
        const status = {
            successRate: `${this.stats.successfulTrades}/${this.stats.totalTrades}`,
            remainingTime: Math.floor(remainingTime / 1000),
            isRunning: this.isRunning
        };
        
        this.emit('status', status);
        logger.info(
            `Status: ${status.successRate} successful trades, ` +
            `${status.remainingTime}s remaining`
        );
    }

    stop() {
        this.isRunning = false;
        logger.info('Stopping bot...');
    }
}

module.exports = SimpleVolumeBot; 