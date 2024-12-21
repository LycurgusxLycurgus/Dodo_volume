const SimpleVolumeBot = require('./simple_volume_bot');
const logger = require('./logger');
const fetch = require('cross-fetch');
const prompts = require('prompts');
require('dotenv').config();

class VolumeTraderApp {
    constructor() {
        this.config = {
            privateKey: process.env.PRIVATE_KEY,
            rpcEndpoint: process.env.SOLANA_RPC_URL,
        };
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
        const recommendedTradeAmount = (0.01 / solPrice).toFixed(3);

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
                    { title: 'Low (0.0005 SOL)', value: 0.0005 },
                    { title: 'Medium (0.001 SOL) - Recommended', value: 0.001 },
                    { title: 'High (0.002 SOL)', value: 0.002 }
                ],
                initial: 1
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

        // Calculate required SOL for fees
        const txPerMinute = 1; // One trade cycle (buy+sell) per minute
        const requiredSol = this.calculateFeesForDuration(
            response.duration,
            txPerMinute,
            response.priorityFee
        );

        logger.info('\nConfiguration Summary:');
        logger.info('=====================');
        logger.info(`Platform: ${response.platform === 'pump' ? 'PumpFun' : 'Raydium/Jupiter'}`);
        logger.info(`Token Address: ${response.tokenAddress}`);
        logger.info(`Trade Amount: $${response.tradeAmountUSD}`);
        logger.info(`Priority Fee: ${response.priorityFee} SOL`);
        logger.info(`Slippage: ${response.slippage}%`);
        logger.info(`Duration: ${response.duration} hours`);
        logger.info(`Required SOL for fees: ${requiredSol.toFixed(2)} SOL`);
        logger.info('=====================\n');

        const confirm = await prompts({
            type: 'confirm',
            name: 'value',
            message: 'Start trading with these settings?',
            initial: true
        });

        if (confirm.value) {
            const bot = new SimpleVolumeBot({
                ...this.config,
                tradeAmountUSD: response.tradeAmountUSD,
                priorityFee: response.priorityFee,
                slippageBps: response.slippage * 100
            });

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