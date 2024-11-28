const SimpleVolumeBot = require('../simple_volume_bot');
const logger = require('../logger');
require('dotenv').config();

async function testSimpleVolumeBot() {
    logger.info('='.repeat(50));
    logger.info('Starting SimpleVolumeBot Test Suite');
    logger.info('='.repeat(50));

    const bot = new SimpleVolumeBot({
        privateKey: process.env.PRIVATE_KEY,
        rpcEndpoint: process.env.SOLANA_RPC_URL,
        tradeAmountUSD: 0.01,
        priorityFee: 0.001 // Updated to 0.001 SOL
    });

    const stats = {
        pumpfun: { successful: 0, total: 0 },
        jupiter: { successful: 0, total: 0 }
    };

    try {
        // Test PumpFun token
        logger.info('\nTesting PumpFun Token:');
        logger.info('Contract: F2ZvSGsC9ps6N6Q1PFQTx9ub6XMXeGmobzqhpBYeoJkW');
        
        // First cycle
        await executeTradeCycle(
            bot, 
            'F2ZvSGsC9ps6N6Q1PFQTx9ub6XMXeGmobzqhpBYeoJkW', 
            'pump',
            stats.pumpfun
        );
        
        // Wait 5 seconds
        await countdown(5);
        
        // Second cycle
        await executeTradeCycle(
            bot, 
            'F2ZvSGsC9ps6N6Q1PFQTx9ub6XMXeGmobzqhpBYeoJkW', 
            'pump',
            stats.pumpfun
        );

        // Test Jupiter/Raydium token
        logger.info('\nTesting Jupiter/Raydium Token:');
        logger.info('Contract: GQUq6WVWtTvV42GhHHXdzhXDC6aYU7B6BpQdNZGYpump');
        
        // First cycle
        await executeTradeCycle(
            bot, 
            'GQUq6WVWtTvV42GhHHXdzhXDC6aYU7B6BpQdNZGYpump', 
            'jupiter',
            stats.jupiter
        );
        
        // Wait 5 seconds
        await countdown(5);
        
        // Second cycle
        await executeTradeCycle(
            bot, 
            'GQUq6WVWtTvV42GhHHXdzhXDC6aYU7B6BpQdNZGYpump', 
            'jupiter',
            stats.jupiter
        );

        // Final countdown
        logger.info('\nStarting final countdown (20 seconds)');
        await countdown(20);

    } catch (error) {
        logger.error('Test suite failed:', error);
        process.exit(1);
    }

    // Print final results
    printResults(stats);
}

async function executeTradeCycle(bot, tokenAddress, platform, stats) {
    try {
        logger.info(`\nExecuting ${platform} trade cycle...`);
        stats.total += 2; // Count both buy and sell

        await bot._executeTradeCycle(tokenAddress, platform);
        stats.successful += 2;
        
        logger.info('Trade cycle completed successfully');
    } catch (error) {
        logger.error(`Trade cycle failed: ${error.message}`);
    }
    
    logger.info(`Current ${platform} stats: ${stats.successful}/${stats.total} successful`);
}

async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
        process.stdout.write(`\rWaiting: ${i} seconds remaining...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.stdout.write('\n');
}

function printResults(stats) {
    logger.info('\n' + '='.repeat(50));
    logger.info('Test Results Summary');
    logger.info('='.repeat(50));
    logger.info('PumpFun Results:');
    logger.info(`- Success Rate: ${stats.pumpfun.successful}/${stats.pumpfun.total}`);
    logger.info('Jupiter Results:');
    logger.info(`- Success Rate: ${stats.jupiter.successful}/${stats.jupiter.total}`);
    logger.info('='.repeat(50));
}

// Run if called directly
if (require.main === module) {
    testSimpleVolumeBot()
        .then(() => {
            logger.info('Test suite completed');
            process.exit(0);
        })
        .catch(error => {
            logger.error('Test suite failed:', error);
            process.exit(1);
        });
}

module.exports = { testSimpleVolumeBot }; 