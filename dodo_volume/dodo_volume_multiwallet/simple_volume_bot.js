require('dotenv').config();
const PumpPortalSwapTester = require('./test_pump_portal_swap');
const JupiterSwapTester = require('./test_jupiter_swap');
const logger = require('./logger');
const EventEmitter = require('events');
const { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  SystemProgram, 
  Transaction 
} = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const web3 = require('@solana/web3.js');
const fetch = require('cross-fetch'); // Ensure cross-fetch is imported if needed

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

        // Add new wallet management properties
        this.connection = new Connection(this.config.rpcEndpoint, 'confirmed');
        this.wallets = {
            main: null,
            traders: []
        };
        this.DB_DIR = path.join(__dirname, 'wallets');

        // Add confirmation settings
        this.confirmationSettings = {
            maxRetries: 3,
            initialDelay: 3000,
            commitment: 'confirmed'
        };
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

        // Initialize trader wallets if not already done
        if (this.wallets.traders.length === 0) {
            await this.initializeTraderWallets();
        }

        this.isRunning = true;
        this.stats.startTime = Date.now();
        this.stats.endTime = this.stats.startTime + duration;

        logger.info('Starting SimpleVolumeBot with configuration:');
        logger.info(`- Token Address: ${tokenAddress}`);
        logger.info(`- Platform: ${tokenType}`);
        logger.info(`- Trade Amount: $${this.config.tradeAmountUSD}`);
        logger.info(`- Slippage: ${this.config.slippageBps / 100}%`);
        logger.info(`- Priority Fee: ${this.config.priorityFee} SOL`);
        logger.info(`- Trade Interval: Random ${this.config.minInterval/1000}-${this.config.maxInterval/1000} seconds`);
        logger.info(`- Duration: ${duration / 1000 / 60} minutes`);
        logger.info(`- Number of parallel traders: ${this.wallets.traders.length}`);

        // Create trading groups (5 wallets per group)
        const walletGroups = [];
        for (let i = 0; i < this.wallets.traders.length; i += 5) {
            walletGroups.push(this.wallets.traders.slice(i, i + 5));
        }

        while (this.isRunning && Date.now() < this.stats.endTime) {
            try {
                // Execute trades in parallel for each group
                await Promise.all(
                    walletGroups.map(group => this._executeGroupTradeCycle(group, tokenAddress, tokenType))
                );
                
                // Update and emit stats
                this._emitStatus();
                
                // Random delay between group trades
                const delay = Math.floor(
                    Math.random() * (this.config.maxInterval - this.config.minInterval) 
                    + this.config.minInterval
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (error) {
                logger.error('Error executing trade cycles:', error);
                this.stats.totalTrades += walletGroups.length * 5; // Count failed attempts
                this._emitStatus();
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        this.isRunning = false;
        logger.info('Bot finished running');
        return this.stats;
    }

    async _executeGroupTradeCycle(walletGroup, tokenAddress, tokenType) {
        try {
            // Execute buys in parallel but with delay between requests
            logger.info(`Executing parallel buys for ${walletGroup.length} wallets`);
            const buyResults = await Promise.all(
                walletGroup.map(async (wallet, index) => {
                    // Add delay between requests
                    if (index > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
                })
            );

            // Wait 5 seconds before selling
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Execute sells in parallel but with delay between requests
            logger.info(`Executing parallel sells for ${walletGroup.length} wallets`);
            const sellResults = await Promise.all(
                walletGroup.map(async (wallet, index) => {
                    // Add delay between requests
                    if (index > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'sell');
                })
            );

            // Update stats
            this.stats.successfulTrades +=
                buyResults.filter(Boolean).length + sellResults.filter(Boolean).length;
            this.stats.totalTrades += walletGroup.length * 2;

            return true;
        } catch (error) {
            logger.error('Trade cycle failed:', error);
            return false;
        }
    }

    // New helper method to execute a single trade
    async _executeSingleTrade(tokenAddress, tokenType, wallet, action) {
        try {
            if (!wallet) {
                throw new Error('No wallet provided for trade execution');
            }

            // Create a new instance of the swap tester with the trader wallet
            const swapTester = tokenType === 'pump' 
                ? new PumpPortalSwapTester()
                : new JupiterSwapTester();
            
            // Initialize the wallet properly based on platform type
            if (tokenType === 'pump') {
                // For PumpPortal
                swapTester.wallet = {
                    publicKey: wallet.publicKey,
                    secretKey: wallet.secretKey,
                    payer: wallet,
                    priorityFee: this.config.priorityFee
                };
                
                // Set priority fee
                swapTester.setPriorityFee(this.config.priorityFee);
                
                await swapTester.executeTrade(
                    tokenAddress, 
                    action,
                    this.config.tradeAmountUSD
                );
            } else {
                // For Jupiter
                swapTester.wallet = {
                    payer: wallet,
                    publicKey: wallet.publicKey,
                    signTransaction: async (tx) => {
                        tx.sign([wallet]);
                        return tx;
                    }
                };

                // Override confirmation with our new method
                swapTester.confirmTransaction = async (signature) => {
                    return await this._confirmTransaction(signature);
                };

                // For Jupiter swaps, handle buy/sell differently
                if (action === 'sell') {
                    // Check token account first
                    const accountInfo = await this._checkTokenAccount(
                        tokenAddress,
                        wallet.publicKey
                    );

                    if (!accountInfo.exists || accountInfo.balance === 0) {
                        logger.warn(`No token balance for wallet ${wallet.publicKey.toString()}`);
                        return false;
                    }

                    // Use 90% of actual balance
                    const sellAmount = Math.floor(accountInfo.balance * 1);

                    // Execute sell with proper parameters
                    await swapTester.testSwap(
                        'So11111111111111111111111111111111111111112',  // outputMint (SOL)
                        sellAmount,                                      // amount in token units
                        tokenAddress,                                    // inputMint (token)
                        { swapMode: 'ExactIn' }
                    );
                } else {
                    // For buys, convert USD to SOL
                    const solPrice = await this.fetchSolPrice();
                    const solAmount = this.config.tradeAmountUSD / solPrice; 
                    
                    // outputMint = token, inputMint = SOL
                    await swapTester.testSwap(
                        tokenAddress,  // outputMint (token we're buying)
                        solAmount,     // amount in SOL units
                        'So11111111111111111111111111111111111111112'  // inputMint (SOL)
                    );
                }
            }

            return true;
        } catch (error) {
            logger.error(`${action.toUpperCase()} failed for wallet ${wallet?.publicKey.toString()}: ${error.message}`);
            return false;
        }
    }

    // Add helper method to fetch SOL price
    async fetchSolPrice() {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data = await response.json();
            return data.solana.usd;
        } catch (error) {
            logger.error('Error fetching SOL price:', error);
            return 230; // Fallback price
        }
    }

    // Update _executeTradeCycle to use the new pattern
    async _executeTradeCycle(tokenAddress, tokenType, wallet = null) {
        this.stats.totalTrades++;
        
        try {
            // Execute buy and sell sequentially for single wallet
            await this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this._executeSingleTrade(tokenAddress, tokenType, wallet, 'sell');
            
            return true;
        } catch (error) {
            logger.error(`Trade cycle failed for wallet ${wallet?.publicKey.toString()}: ${error.message}`);
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

    // New method to create trader wallets
    async createTraderWallets(numWallets = 10) {
        logger.info(`Creating ${numWallets} trader wallets...`);
        
        // Create DB directory if it doesn't exist
        if (!fs.existsSync(this.DB_DIR)) {
            fs.mkdirSync(this.DB_DIR, { recursive: true });
        }

        // Create main wallet from private key
        this.wallets.main = Keypair.fromSecretKey(
            bs58.decode(this.config.privateKey)
        );
        logger.info(`Main wallet: ${this.wallets.main.publicKey.toString()}`);

        // Create trader wallets
        for (let i = 0; i < numWallets; i++) {
            const wallet = Keypair.generate();
            this.wallets.traders.push(wallet);
            
            // Save wallet data
            const walletData = {
                id: `trader_${i}`,
                publicKey: wallet.publicKey.toString(),
                privateKey: bs58.encode(wallet.secretKey)
            };
            
            fs.writeFileSync(
                path.join(this.DB_DIR, `trader_${i}.json`),
                JSON.stringify(walletData, null, 2)
            );
            
            logger.info(`Created trader wallet ${i}: ${wallet.publicKey.toString()}`);
        }

        return this.wallets.traders;
    }

    // New method to check wallet balance
    async checkWalletBalance(wallet) {
        try {
            const balance = await this.connection.getBalance(wallet.publicKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            logger.error(`Error checking balance: ${error.message}`);
            throw error;
        }
    }

    // New method to fund a trader wallet with retry logic
    async fundTraderWallet(traderWallet, amount) {
        const maxRetries = 3;
        const confirmationTimeout = 30000; // 30 seconds

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const lamports = Math.round(amount * LAMPORTS_PER_SOL);
                
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallets.main.publicKey,
                        toPubkey: traderWallet.publicKey,
                        lamports: lamports,
                    })
                );

                const signature = await this.connection.sendTransaction(
                    transaction,
                    [this.wallets.main]
                );

                logger.info(`Funding attempt ${attempt}: Transaction sent with signature ${signature}`);

                // Wait for confirmation with active checking
                let confirmed = false;
                const startTime = Date.now();

                while (Date.now() - startTime < confirmationTimeout) {
                    try {
                        const status = await this.connection.getSignatureStatus(signature);
                        
                        if (status.value?.confirmationStatus === 'confirmed' || 
                            status.value?.confirmationStatus === 'finalized') {
                            confirmed = true;
                            logger.info(
                                `Funded wallet ${traderWallet.publicKey.toString()} with ${amount} SOL (${status.value.confirmationStatus})`
                            );
                            return signature;
                        }

                        if (status.value?.err) {
                            throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                        }

                        // Wait 2 seconds before next check
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } catch (checkError) {
                        logger.error(`Error checking transaction status: ${checkError.message}`);
                        // Continue if it's just a status check error
                    }
                }

                if (!confirmed) {
                    if (attempt === maxRetries) {
                        throw new Error(`Transaction confirmation timed out after ${maxRetries} attempts`);
                    }
                    logger.warn(`Attempt ${attempt} timed out, retrying...`);
                    // Add increasing delay
                    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
                }
            } catch (error) {
                if (attempt === maxRetries) {
                    logger.error(`All funding attempts failed: ${error.message}`);
                    throw error;
                }
                logger.warn(`Attempt ${attempt} failed: ${error.message}, retrying...`);
                // Add increasing delay
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
    }

    // New method to initialize all trader wallets with funds
    async initializeTraderWallets(solPerWallet = 0.01) {
        logger.info('Initializing trader wallets...');
        
        if (!this.wallets.main || this.wallets.traders.length === 0) {
            throw new Error('Wallets not properly initialized');
        }

        // First check all trader wallet balances
        const traderBalances = await Promise.all(
            this.wallets.traders.map(async wallet => {
                const balance = await this.checkWalletBalance(wallet);
                return { wallet, balance };
            })
        );

        // Calculate how much total SOL needed
        const fundingNeeded = traderBalances.reduce((total, { balance }) => {
            const needed = balance < solPerWallet ? solPerWallet - balance : 0;
            return total + needed;
        }, 0);

        if (fundingNeeded > 0) {
            // Check main wallet balance
            const mainBalance = await this.checkWalletBalance(this.wallets.main);
            
            if (mainBalance < fundingNeeded) {
                throw new Error(
                    `Insufficient balance in main wallet. Need ${fundingNeeded} SOL, has ${mainBalance} SOL`
                );
            }

            // Fund only wallets that need it
            for (const { wallet, balance } of traderBalances) {
                if (balance < solPerWallet) {
                    const needed = solPerWallet - balance;
                    await this.fundTraderWallet(wallet, needed);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    logger.info(
                        `Trader wallet ${wallet.publicKey.toString()} already has sufficient balance: ${balance} SOL`
                    );
                }
            }
        } else {
            logger.info('All trader wallets already have sufficient balance');
        }

        logger.info('All trader wallets initialized successfully');
    }

    // Add new method to load existing wallets
    async loadExistingWallets() {
        logger.info('Loading existing trader wallets...');
        
        // Create main wallet from private key
        this.wallets.main = Keypair.fromSecretKey(
            bs58.decode(this.config.privateKey)
        );
        logger.info(`Main wallet: ${this.wallets.main.publicKey.toString()}`);

        try {
            // Check if wallets directory exists
            if (!fs.existsSync(this.DB_DIR)) {
                throw new Error('No existing wallets found');
            }

            // Read all wallet files
            const files = fs.readdirSync(this.DB_DIR);
            const traderFiles = files.filter(f => f.startsWith('trader_'));

            if (traderFiles.length === 0) {
                throw new Error('No trader wallets found');
            }

            // Load each wallet
            for (const file of traderFiles) {
                const walletData = JSON.parse(
                    fs.readFileSync(path.join(this.DB_DIR, file))
                );
                const wallet = Keypair.fromSecretKey(
                    bs58.decode(walletData.privateKey)
                );
                this.wallets.traders.push(wallet);
                logger.info(`Loaded trader wallet: ${wallet.publicKey.toString()}`);
            }

            logger.info(`Loaded ${this.wallets.traders.length} existing trader wallets`);
        } catch (error) {
            logger.error('Error loading existing wallets:', error);
            throw error;
        }
    }

    // Add helper method to get token balance
    async _getTokenBalance(tokenAddress, walletAddress) {
        try {
            const mintPubkey = new web3.PublicKey(tokenAddress);
            const walletPubkey = new web3.PublicKey(walletAddress);

            const response = await this.connection.getTokenAccountsByOwner(walletPubkey, {
                mint: mintPubkey
            });

            if (response.value.length === 0) {
                return 0;
            }

            const tokenAccount = response.value[0];
            const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount.pubkey);
            return accountInfo.value.amount;
        } catch (error) {
            logger.error(`Error getting token balance: ${error.message}`);
            throw error;
        }
    }

    // Add new confirmation method
    async _confirmTransaction(signature) {
        try {
            const { blockhash, lastValidBlockHeight } = 
                await this.connection.getLatestBlockhash('confirmed');

            let attempts = 0;
            const maxAttempts = 5;
            let rateLimitRetries = 0;
            const maxRateLimitRetries = 3;

            while (attempts < maxAttempts) {
                try {
                    const status = await this.connection.getSignatureStatus(signature);
                    
                    if (status?.value?.err) {
                        logger.error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                        return false;
                    }

                    if (status?.value?.confirmationStatus === 'confirmed' || 
                        status?.value?.confirmationStatus === 'finalized') {
                        return true;
                    }

                    attempts++;
                    await new Promise(resolve => 
                        setTimeout(resolve, this.confirmationSettings.initialDelay * Math.pow(2, attempts))
                    );

                } catch (error) {
                    if (error.message.includes('429')) {
                        rateLimitRetries++;
                        if (rateLimitRetries > maxRateLimitRetries) {
                            return await this._checkSolscanStatus(signature);
                        }
                        await new Promise(resolve => 
                            setTimeout(resolve, 1000 * Math.pow(2, rateLimitRetries))
                        );
                        continue;
                    }
                    throw error;
                }
            }

            return await this._checkSolscanStatus(signature);

        } catch (error) {
            logger.error(`Error confirming transaction: ${error.message}`);
            return false;
        }
    }

    // Add token account check before selling
    async _checkTokenAccount(tokenAddress, walletAddress) {
        try {
            const mintPubkey = new web3.PublicKey(tokenAddress);
            const walletPubkey = new web3.PublicKey(walletAddress);
            
            // Get token accounts
            const accounts = await this.connection.getTokenAccountsByOwner(
                walletPubkey,
                { mint: mintPubkey }
            );

            // Return if account exists and has balance
            if (accounts.value.length > 0) {
                const balance = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
                return {
                    exists: true,
                    balance: balance.value.amount,
                    account: accounts.value[0].pubkey
                };
            }

            return { exists: false, balance: 0, account: null };
        } catch (error) {
            logger.error(`Error checking token account: ${error.message}`);
            return { exists: false, balance: 0, account: null };
        }
    }
}

module.exports = SimpleVolumeBot;