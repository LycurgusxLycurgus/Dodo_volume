const SimpleVolumeBot = require('./simple_volume_bot');
const logger = require('./logger');
const fetch = require('cross-fetch');
const prompts = require('prompts');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

class VolumeTraderApp {
    constructor() {
        this.config = {
            privateKey: process.env.PRIVATE_KEY,
            rpcEndpoint: process.env.SOLANA_RPC_URL,
        };
        this.DB_DIR = path.join(__dirname, 'wallets');
    }

    async fetchSolPrice() {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data = await response.json();
            return data.solana.usd;
        } catch (error) {
            logger.error('Error fetching SOL price:', error);
            return 100; // Fallback price if API fails
        }
    }

    calculateFeesForDuration(hours, txPerMinute, priorityFee) {
        const totalTx = hours * 60 * txPerMinute;
        const feePerTx = priorityFee * 2; // Buy + Sell
        return totalTx * feePerTx;
    }

    async start() {
        logger.info('Welcome to Volume Trader Bot');
        logger.info('=============================\n');

        const solPrice = await this.fetchSolPrice();
        
        // Check for existing wallets first
        let existingWalletCount = 0;
        try {
            if (fs.existsSync(this.DB_DIR)) {
                const files = fs.readdirSync(this.DB_DIR);
                existingWalletCount = files.filter(f => f.startsWith('trader_')).length;
            }
        } catch (error) {
            logger.warn('Error checking existing wallets:', error);
        }
        
        // Add wallet initialization questions
        const walletQuestions = [
            {
                type: 'confirm',
                name: 'useExisting',
                message: `Found ${existingWalletCount} existing trader wallets. Use them?`,
                initial: existingWalletCount > 0
            },
            {
                type: (prev) => !prev ? 'number' : null,
                name: 'numWallets',
                message: 'Enter number of trader wallets to create (2-10):',
                initial: 5,
                validate: value => value >= 2 && value <= 10
            },
            {
                type: 'number',
                name: 'solPerWallet',
                message: 'Enter SOL amount per trader wallet:',
                initial: 0.01,
                float: true,
                validate: value => value >= 0.01
            }
        ];

        const walletSetup = await prompts(walletQuestions);
        
        // Initialize bot early to setup wallets
        const bot = new SimpleVolumeBot({
            ...this.config,
            tradeAmountUSD: 0.01,
            priorityFee: 0.001,
            slippageBps: 500
        });

        // Initialize trader wallets
        logger.info('\nInitializing trader wallets...');
        try {
            if (walletSetup.useExisting) {
                await bot.loadExistingWallets();
                logger.info(`\nFound ${bot.wallets.traders.length} existing trader wallets`);
            } else {
                await bot.createTraderWallets(walletSetup.numWallets);
            }

            // Check main wallet balance and wait for funding if needed
            const mainBalance = await bot.checkWalletBalance(bot.wallets.main);
            const requiredBalance = walletSetup.solPerWallet * (walletSetup.useExisting ? bot.wallets.traders.length : walletSetup.numWallets);
            
            if (mainBalance < requiredBalance) {
                logger.info(`\nInsufficient balance in main wallet.`);
                logger.info(`Current balance: ${mainBalance} SOL`);
                logger.info(`Required balance: ${requiredBalance} SOL`);
                logger.info(`Please fund the main wallet with at least ${(requiredBalance - mainBalance).toFixed(3)} SOL`);
                logger.info(`Main wallet address: ${bot.wallets.main.publicKey.toString()}`);
                
                const waitForFunding = await prompts({
                    type: 'confirm',
                    name: 'value',
                    message: 'Press Enter when wallet is funded (or N to cancel)',
                    initial: true
                });

                if (!waitForFunding.value) {
                    logger.info('Operation cancelled');
                    return;
                }
            }

            await bot.initializeTraderWallets(walletSetup.solPerWallet);
        } catch (error) {
            logger.error('Failed to initialize wallets:', error);
            return;
        }

        // Continue with existing trading setup questions
        const questions = [
            {
                type: 'select',
                name: 'platform',
                message: 'Select the trading platform:',
                choices: [
                    { title: 'PumpFun (Bonding Curve)', value: 'pump' },
                    { title: 'Raydium/Jupiter', value: 'jupiter' }
                ],
                initial: 0
            },
            {
                type: 'text',
                name: 'tokenAddress',
                message: 'Enter the token mint address:'
            },
            {
                type: 'number',
                name: 'tradeAmountUSD',
                message: `Enter trade amount in USD (recommended: $0.01):`,
                initial: 0.01,
                float: true
            },
            {
                type: 'select',
                name: 'priorityFee',
                message: 'Select priority fee level:',
                choices: [
                    { title: 'Very Low (0.0001 SOL) - Recommended', value: 0.0001 },
                    { title: 'Low (0.0005 SOL)', value: 0.0005 },
                    { title: 'Medium (0.001 SOL)', value: 0.001 },
                    { title: 'High (0.002 SOL)', value: 0.002 }
                ],
                initial: 0
            },
            {
                type: 'select',
                name: 'slippage',
                message: 'Select slippage tolerance:',
                choices: [
                    { title: '5% - Recommended', value: 5 },
                    { title: '10%', value: 10 },
                    { title: '15%', value: 15 }
                ],
                initial: 0
            },
            {
                type: 'select',
                name: 'duration',
                message: 'Select trading duration:',
                choices: [
                    { title: '6 hours', value: 6 },
                    { title: '12 hours', value: 12 },
                    { title: '24 hours', value: 24 }
                ]
            }
        ];

        const response = await prompts(questions);

        // Calculate total required SOL including wallet funding
        const txPerMinute = walletSetup.useExisting ? bot.wallets.traders.length : walletSetup.numWallets;
        const tradingFees = this.calculateFeesForDuration(
            response.duration,
            txPerMinute,
            response.priorityFee
        );
        const totalRequired = tradingFees + (walletSetup.solPerWallet * txPerMinute);

        logger.info('\nConfiguration Summary:');
        logger.info('=====================');
        logger.info(`Number of trader wallets: ${txPerMinute}`);
        logger.info(`SOL per trader wallet: ${walletSetup.solPerWallet} SOL`);
        logger.info(`Platform: ${response.platform === 'pump' ? 'PumpFun' : 'Raydium/Jupiter'}`);
        logger.info(`Token Address: ${response.tokenAddress}`);
        logger.info(`Trade Amount: $${response.tradeAmountUSD}`);
        logger.info(`Priority Fee: ${response.priorityFee} SOL`);
        logger.info(`Slippage: ${response.slippage}%`);
        logger.info(`Duration: ${response.duration} hours`);
        logger.info(`Required SOL for fees: ${tradingFees.toFixed(2)} SOL`);
        logger.info(`Total required SOL: ${totalRequired.toFixed(2)} SOL`);
        logger.info('=====================\n');

        const confirm = await prompts({
            type: 'confirm',
            name: 'value',
            message: 'Start trading with these settings?',
            initial: true
        });

        if (confirm.value) {
            // Update bot configuration with ALL user settings
            bot.config = {
                ...bot.config, // Preserve existing config values
                tradeAmountUSD: response.tradeAmountUSD,
                priorityFee: response.priorityFee,
                slippageBps: response.slippage * 100,
                // Add any other config values that should be preserved
            };

            // Log actual configuration that will be used
            logger.info('\nConfirmed Bot Configuration:');
            logger.info('=====================');
            logger.info(`Trade Amount: $${bot.config.tradeAmountUSD}`);
            logger.info(`Priority Fee: ${bot.config.priorityFee} SOL`);
            logger.info(`Slippage: ${bot.config.slippageBps / 100}%`);
            logger.info('=====================\n');

            const duration = response.duration * 60 * 60 * 1000; // Convert hours to milliseconds
            await bot.start(response.tokenAddress, duration, response.platform);
        } else {
            logger.info('Trading cancelled. Goodbye!');
        }
    }
}

// Run if called directly
if (require.main === module) {
    const app = new VolumeTraderApp();
    app.start()
        .catch(error => {
            logger.error('Application error:', error);
            process.exit(1);
        });
}

module.exports = VolumeTraderApp; 