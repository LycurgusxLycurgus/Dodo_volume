const RaydiumPortalClient = require('../raydium_portal');
const logger = require('../logger');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Single client instance for the entire application
const client = new RaydiumPortalClient();

async function question(query) {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
}

async function watchNewTokens() {
    logger.info('=== Starting New Token Monitoring on Raydium ===');
    
    try {
        logger.info('Connecting to Raydium...');
        await client.connect();
        logger.info('Connected successfully, monitoring new tokens...');
        
        await client.monitorNewTokens((data) => {
            logger.info('=== New Token Detected on Raydium ===');
            logger.info(JSON.stringify(data.token, null, 2));
        });
        
        logger.info('Monitoring for new tokens... Press Ctrl+C to stop');
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function watchTokenTransactions() {
    logger.info('=== Starting Token Transaction Monitoring on Raydium ===');
    
    const input = await question('Enter token mint addresses (comma-separated): ');
    const tokenAddresses = input.split(',').map(addr => addr.trim());
    
    try {
        await client.connect();  // Will reuse existing connection if already connected
        
        for (const tokenAddress of tokenAddresses) {
            await client.monitorTokenTransactions(tokenAddress, (data) => {
                logger.info('=== Token Transaction Detected ===');
                logger.info(JSON.stringify({
                    tokenMint: data.tokenMint,
                    signature: data.context.signature,
                    logs: data.logs
                }, null, 2));
            });
        }
        
        logger.info(`Monitoring transactions for tokens: ${tokenAddresses.join(', ')}... Press Ctrl+C to stop`);
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function watchAccountTransactions() {
    logger.info('=== Starting Account Transaction Monitoring on Raydium ===');
    
    const input = await question('Enter account addresses (comma-separated): ');
    const accountAddresses = input.split(',').map(addr => addr.trim());
    
    try {
        await client.connect();  // Will reuse existing connection if already connected
        
        for (const accountAddress of accountAddresses) {
            await client.monitorAccountTransactions(accountAddress, (data) => {
                logger.info('=== Account Transaction Detected ===');
                logger.info(JSON.stringify({
                    account: data.account,
                    signature: data.context.signature,
                    logs: data.logs
                }, null, 2));
            });
        }
        
        logger.info(`Monitoring transactions for accounts: ${accountAddresses.join(', ')}... Press Ctrl+C to stop`);
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        throw error;
    }
}

async function main() {
    try {
        console.log('\nRaydium Portal Monitoring Options:');
        console.log('1. Monitor New Tokens');
        console.log('2. Monitor Token Transactions');
        console.log('3. Monitor Account Transactions');
        
        const choice = await question('\nSelect an option (1-3): ');

        switch (choice) {
            case '1':
                await watchNewTokens();
                break;
            case '2':
                await watchTokenTransactions();
                break;
            case '3':
                await watchAccountTransactions();
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
    watchTokenTransactions,
    watchAccountTransactions
}; 