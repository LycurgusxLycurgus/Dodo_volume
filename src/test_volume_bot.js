require('dotenv').config();
const VolumeBot = require('./volume_bot');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const readline = require('readline');
const logger = require('./logger');

class VolumeBotTester {
    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        // Load and validate environment variables
        this.validateEnvironment();

        // Default RPC endpoint
        const rpcEndpoint = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

        this.testConfigs = {
            jupiter: {
                rpcEndpoint: rpcEndpoint,
                slippageBps: 50,
                priorityFeeAmount: 100000,
                maxSlippageBps: 300
            },
            rpcEndpoint: rpcEndpoint,
            baseToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            baseTokenDecimals: 6,
            targetVolume: 1000,
            minTradeSize: 10,
            maxTradeSize: 100,
            tradeInterval: 5000, // 5 seconds for testing
            privateKey: process.env.PRIVATE_KEY
        };
    }

    validateEnvironment() {
        const requiredEnvVars = {
            'PRIVATE_KEY': process.env.PRIVATE_KEY,
            'SOLANA_RPC_URL': process.env.SOLANA_RPC_URL
        };

        const missingVars = Object.entries(requiredEnvVars)
            .filter(([_, value]) => !value)
            .map(([key]) => key);

        if (missingVars.length > 0) {
            logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
            logger.error('Please check your .env file and ensure all required variables are set');
            process.exit(1);
        }

        // Validate private key format
        try {
            const privateKeyBytes = bs58.decode(process.env.PRIVATE_KEY);
            if (privateKeyBytes.length !== 64) {
                throw new Error('Invalid private key length');
            }
        } catch (error) {
            logger.error('Invalid private key format in .env file');
            process.exit(1);
        }
    }

    async question(query) {
        return new Promise((resolve) => this.rl.question(query, resolve));
    }

    printSection(title) {
        console.log('\n===========================================');
        console.log(`${new Date().toISOString()} - ${title}`);
        console.log('===========================================\n');
    }

    async initializeBot(tokenAddress, platform) {
        try {
            this.printSection('Initializing Volume Bot');

            // Get public key from private key for PumpPortal
            let publicKey;
            if (platform === 'pump') {
                const keypair = Keypair.fromSecretKey(bs58.decode(this.testConfigs.privateKey));
                publicKey = keypair.publicKey.toString();
            }

            const bot = new VolumeBot({
                ...this.testConfigs,
                jupiter: platform === 'jupiter' ? this.testConfigs.jupiter : undefined,
                platform: platform,
                publicKey: publicKey
            });

            logger.info('Connecting to trading portals...');
            await bot.connect();
            logger.info('Successfully connected to trading portals');

            return bot;
        } catch (error) {
            logger.error('Failed to initialize bot:', error);
            throw error;
        }
    }

    async runVolumeTest(bot, tokenAddress, targetVolume, duration) {
        try {
            this.printSection(`Running Volume Test - Target: $${targetVolume} for ${duration}s`);
            
            // Configure volume test parameters
            bot.config.targetVolume = targetVolume;
            bot.config.tradeInterval = 5000; // 5 seconds between trades for testing

            // Start volume bot
            await bot.startVolumeBot(tokenAddress);
            logger.info(`Volume bot started for ${tokenAddress}`);

            // Monitor volume progress
            const startTime = Date.now();
            const endTime = startTime + (duration * 1000);

            while (Date.now() < endTime && bot.isRunning) {
                const tokenState = bot.activeTokens.get(tokenAddress);
                const currentVolume = tokenState ? tokenState.currentVolume : 0;
                const timeElapsed = Math.floor((Date.now() - startTime) / 1000);
                const progress = (currentVolume / targetVolume) * 100;

                logger.info(`Time: ${timeElapsed}s | Volume: $${currentVolume.toFixed(2)} | Progress: ${progress.toFixed(2)}%`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            // Stop volume bot
            await bot.stopVolumeBot(tokenAddress);
            logger.info('Volume test completed');

        } catch (error) {
            logger.error('Volume test failed:', error);
            throw error;
        }
    }

    async runFastTradeTest(bot, tokenAddress, numTrades) {
        try {
            this.printSection(`Running Fast Trade Test - ${numTrades} trades`);

            // Configure fast trade parameters
            bot.config.tradeInterval = 1000; // 1 second between trades
            bot.config.minTradeSize = 5;
            bot.config.maxTradeSize = 10;

            const trades = [];
            for (let i = 0; i < numTrades; i++) {
                const startTime = Date.now();
                
                try {
                    // Execute buy
                    const buyTxid = await bot._executeVolumeTrade(tokenAddress, 10);
                    
                    // Execute sell after 2 seconds
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const sellTxid = await bot._executeVolumeTrade(tokenAddress, -10);

                    const endTime = Date.now();
                    trades.push({
                        index: i + 1,
                        duration: endTime - startTime,
                        buyTxid,
                        sellTxid
                    });

                    logger.info(`Trade ${i + 1}/${numTrades} completed in ${endTime - startTime}ms`);
                    logger.info(`Buy: ${buyTxid}`);
                    logger.info(`Sell: ${sellTxid}`);

                } catch (error) {
                    logger.error(`Trade ${i + 1} failed:`, error);
                    trades.push({
                        index: i + 1,
                        error: error.message
                    });
                }

                // Wait before next trade
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Print trade summary
            this.printSection('Fast Trade Test Summary');
            console.table(trades);

        } catch (error) {
            logger.error('Fast trade test failed:', error);
            throw error;
        }
    }

    async start() {
        try {
            this.printSection('Volume Bot Test Suite');

            // Get token information
            const tokenAddress = await this.question('Enter token address: ');
            const isPumpFun = (await this.question('Is token on PumpFun? (y/n): ')).toLowerCase() === 'y';
            
            // Initialize bot with appropriate platform
            const platform = isPumpFun ? 'pump' : 'jupiter';
            const bot = await this.initializeBot(tokenAddress, platform);

            // Test menu
            while (true) {
                console.log('\nTest Options:');
                console.log('1. Run Volume Test');
                console.log('2. Run Fast Trade Test');
                console.log('3. Exit');

                const choice = await this.question('\nSelect an option (1-3): ');

                switch (choice) {
                    case '1':
                        const targetVolume = parseFloat(await this.question('Enter target volume in USD: '));
                        const duration = parseInt(await this.question('Enter test duration in seconds: '));
                        await this.runVolumeTest(bot, tokenAddress, targetVolume, duration);
                        break;

                    case '2':
                        const numTrades = parseInt(await this.question('Enter number of trades to execute: '));
                        await this.runFastTradeTest(bot, tokenAddress, numTrades);
                        break;

                    case '3':
                        await bot.close();
                        this.rl.close();
                        return;

                    default:
                        console.log('Invalid option selected');
                }
            }

        } catch (error) {
            logger.error('Test suite failed:', error);
            this.rl.close();
            process.exit(1);
        }
    }
}

// Run if called directly
if (require.main === module) {
    const tester = new VolumeBotTester();
    tester.start().catch(console.error);
}

module.exports = VolumeBotTester; 