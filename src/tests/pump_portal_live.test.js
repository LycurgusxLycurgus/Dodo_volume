const PumpPortalClient = require('../pump_portal');
const logger = require('../logger');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Single client instance for the entire application
const client = new PumpPortalClient();

async function question(query) {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
}

async function watchNewTokens() {
    logger.info('=== Starting New Token Monitoring ===');
    
    client.addCallback('new_token', async (data) => {
        logger.info('=== New Token Detected ===');
        logger.info(JSON.stringify(data.token, null, 2));
    });

    try {
        logger.info('Connecting to PumpPortal...');
        await client.connect();
        logger.info('Connected successfully, subscribing to new tokens...');
        await client.subscribeNewToken();
        logger.info('Monitoring for new tokens... Press Ctrl+C to stop');
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function watchTokenTrades() {
    logger.info('=== Starting Token Trade Monitoring ===');
    
    const input = await question('Enter token addresses (comma-separated): ');
    const tokenAddresses = input.split(',').map(addr => addr.trim());
    
    client.on('message', (data) => {
        if (data.type === 'token_trade') {
            logger.info('=== Token Trade Detected ===');
            logger.info(JSON.stringify(data.trade, null, 2));
        }
    });

    try {
        await client.connect();  // Will reuse existing connection if already connected
        await client.subscribeTokenTrade(tokenAddresses);
        logger.info(`Monitoring trades for tokens: ${tokenAddresses.join(', ')}... Press Ctrl+C to stop`);
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function watchAccountTrades() {
    logger.info('=== Starting Account Trade Monitoring ===');
    
    const input = await question('Enter account addresses (comma-separated): ');
    const accountAddresses = input.split(',').map(addr => addr.trim());
    
    client.on('message', (data) => {
        if (data.type === 'account_trade') {
            logger.info('=== Account Trade Detected ===');
            logger.info(JSON.stringify(data.trade, null, 2));
        }
    });

    try {
        await client.connect();  // Will reuse existing connection if already connected
        await client.subscribeAccountTrade(accountAddresses);
        logger.info(`Monitoring trades for accounts: ${accountAddresses.join(', ')}... Press Ctrl+C to stop`);
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function main() {
    try {
        console.log('\nPumpPortal Monitoring Options:');
        console.log('1. Monitor New Tokens');
        console.log('2. Monitor Token Trades');
        console.log('3. Monitor Account Trades');
        
        const choice = await question('\nSelect an option (1-3): ');

        switch (choice) {
            case '1':
                await watchNewTokens();
                break;
            case '2':
                await watchTokenTrades();
                break;
            case '3':
                await watchAccountTrades();
                break;
            default:
                console.log('Invalid option selected');
                process.exit(1);
        }

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            logger.info('\nShutting down...');
            await client.close();
            rl.close();
            process.exit(0);
        });

    } catch (error) {
        logger.error('Error:', error);
        await client.close();
        rl.close();
        process.exit(1);
    }
}

// Only run if called directly (not in test environment)
if (require.main === module) {
    main().catch(console.error);
}

// Export for testing
module.exports = {
    watchNewTokens,
    watchTokenTrades,
    watchAccountTrades
}; 