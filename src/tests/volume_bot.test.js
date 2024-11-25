const VolumeBot = require('../volume_bot');
const logger = require('../logger');

async function testVolumeBot() {
    const bot = new VolumeBot({
        targetVolume: 10000,    // $10,000 target volume
        minTradeSize: 50,       // Minimum $50 trades
        maxTradeSize: 500,      // Maximum $500 trades
        tradeInterval: 30000,   // Trade every 30 seconds
        slippageTolerance: 0.02 // 2% slippage tolerance
    });

    try {
        // Connect to trading platforms
        await bot.connect();

        // Example token addresses (replace with real addresses)
        const pumpToken = "PUMP_TOKEN_ADDRESS";
        const raydiumToken = "RAYDIUM_TOKEN_ADDRESS";

        // Listen for trade events
        bot.on('trade', (data) => {
            logger.info('Trade executed:', data);
        });

        // Start volume bot for both platforms
        await bot.startVolumeBot(pumpToken, 'pump');
        await bot.startVolumeBot(raydiumToken, 'raydium');

        // Run for 5 minutes then stop
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));

        // Stop the bots
        await bot.stopVolumeBot(pumpToken);
        await bot.stopVolumeBot(raydiumToken);
        await bot.close();

    } catch (error) {
        logger.error('Error in volume bot test:', error);
        await bot.close();
    }
}

// Run the test if called directly
if (require.main === module) {
    testVolumeBot().catch(console.error);
}

module.exports = {
    testVolumeBot
}; 