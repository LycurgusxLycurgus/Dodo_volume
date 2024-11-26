const WebSocket = require('ws');
const { VersionedTransaction, Connection, Keypair } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('./logger');
const bs58 = require('bs58');
const fetch = require('cross-fetch');

class PumpPortalClient extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            rpcEndpoint: config.rpcEndpoint || 'https://api.mainnet-beta.solana.com',
            wsEndpoint: 'wss://pumpportal.fun/api/data',
            tradeEndpoint: 'https://pumpportal.fun/api/trade-local',
            jitoEndpoint: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
            ...config
        };
        
        this.connection = new Connection(this.config.rpcEndpoint, 'confirmed');
        this.ws = null;
        this.isConnected = false;
        this.subscribedTokens = new Set();
        this.subscribedAccounts = new Set();
        this.callbacks = {
            new_token: [],
            token_trade: [],
            account_trade: []
        };
        this.connectionPromise = null;
    }

    async connect() {
        if (this.isConnected && this.ws) {
            logger.info('Already connected to PumpPortal');
            return;
        }

        if (this.connectionPromise) {
            logger.info('Connection already in progress, waiting...');
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            try {
                logger.info('Connecting to PumpPortal...');
                this.ws = new WebSocket(this.config.wsEndpoint, {
                    handshakeTimeout: 30000,
                    perMessageDeflate: false
                });

                this.ws.on('open', () => {
                    logger.info('Connected to PumpPortal WebSocket');
                    this.isConnected = true;
                    this.connectionPromise = null;
                    this.emit('connected');
                    resolve();
                });

                this.ws.on('message', async (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        await this._handleMessage(message);
                    } catch (error) {
                        logger.error('Error parsing message:', error);
                    }
                });

                this.ws.on('close', () => {
                    logger.info('WebSocket connection closed');
                    this.isConnected = false;
                    this.ws = null;
                    this.connectionPromise = null;
                    this.emit('disconnected');
                });

                this.ws.on('error', (error) => {
                    logger.error('WebSocket error:', error);
                    this.isConnected = false;
                    this.ws = null;
                    this.connectionPromise = null;
                    reject(error);
                });

            } catch (error) {
                logger.error('Failed to create WebSocket:', error);
                this.connectionPromise = null;
                reject(error);
            }
        });

        return this.connectionPromise;
    }

    async executeTrade(params) {
        try {
            const response = await fetch(this.config.tradeEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(params)
            });

            if (response.status !== 200) {
                throw new Error(`Trade request failed: ${response.statusText}`);
            }

            const data = await response.arrayBuffer();
            const tx = VersionedTransaction.deserialize(new Uint8Array(data));
            
            if (!this.config.signerKeyPair) {
                throw new Error('Signer keypair not configured');
            }

            tx.sign([this.config.signerKeyPair]);
            const signature = await this.connection.sendTransaction(tx);
            
            logger.info(`Transaction sent: https://solscan.io/tx/${signature}`);
            return signature;
        } catch (error) {
            logger.error('Failed to execute trade:', error);
            throw error;
        }
    }

    async executeTradeBundle(bundleParams) {
        try {
            // Validate bundle parameters
            if (!Array.isArray(bundleParams) || bundleParams.length === 0 || bundleParams.length > 5) {
                throw new Error('Bundle must contain between 1 and 5 transactions');
            }

            // Get transactions from PumpPortal
            const response = await fetch(this.config.tradeEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bundleParams)
            });

            if (response.status !== 200) {
                throw new Error(`Bundle request failed: ${response.statusText}`);
            }

            const transactions = await response.json();
            let encodedSignedTransactions = [];
            let signatures = [];

            // Sign each transaction
            for (let i = 0; i < bundleParams.length; i++) {
                const tx = VersionedTransaction.deserialize(new Uint8Array(bs58.decode(transactions[i])));
                const signerKeyPair = this.config.bundleSigners[i];
                
                if (!signerKeyPair) {
                    throw new Error(`No signer configured for transaction ${i}`);
                }

                tx.sign([signerKeyPair]);
                encodedSignedTransactions.push(bs58.encode(tx.serialize()));
                signatures.push(bs58.encode(tx.signatures[0]));
            }

            // Send bundle to Jito
            const jitoResponse = await fetch(this.config.jitoEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'sendBundle',
                    params: [encodedSignedTransactions]
                })
            });

            if (!jitoResponse.ok) {
                throw new Error(`Jito bundle submission failed: ${jitoResponse.statusText}`);
            }

            // Log transaction signatures
            signatures.forEach((sig, i) => {
                logger.info(`Transaction ${i}: https://solscan.io/tx/${sig}`);
            });

            return signatures;
        } catch (error) {
            logger.error('Failed to execute trade bundle:', error);
            throw error;
        }
    }

    // Existing WebSocket methods
    async _sendMessage(payload) {
        if (!this.isConnected || !this.ws) {
            throw new Error('Not connected to WebSocket');
        }
        
        try {
            this.ws.send(JSON.stringify(payload));
        } catch (error) {
            logger.error('Error sending message:', error);
            throw error;
        }
    }

    async subscribeNewToken() {
        await this._sendMessage({ method: "subscribeNewToken" });
        logger.info('Subscribed to new token events');
    }

    async subscribeTokenTrade(tokenAddresses) {
        const newTokens = tokenAddresses.filter(addr => !this.subscribedTokens.has(addr));
        if (newTokens.length > 0) {
            await this._sendMessage({
                method: "subscribeTokenTrade",
                keys: newTokens
            });
            newTokens.forEach(token => this.subscribedTokens.add(token));
            logger.info(`Subscribed to trades for tokens: ${newTokens.join(', ')}`);
        }
    }

    async unsubscribeTokenTrade(tokenAddresses) {
        await this._sendMessage({
            method: "unsubscribeTokenTrade",
            keys: tokenAddresses
        });
        tokenAddresses.forEach(token => this.subscribedTokens.delete(token));
        logger.info(`Unsubscribed from trades for tokens: ${tokenAddresses.join(', ')}`);
    }

    async _handleMessage(data) {
        logger.debug('Received message:', data);
        
        const messageType = data.type;
        if (!messageType) {
            logger.info('Message without type field:', data);
            return;
        }

        this.emit('message', data);
        this.emit(messageType, data);

        if (this.callbacks[messageType]) {
            for (const callback of this.callbacks[messageType]) {
                try {
                    await callback(data);
                } catch (error) {
                    logger.error(`Error in ${messageType} callback:`, error);
                }
            }
        }
    }

    addCallback(eventType, callback) {
        if (eventType in this.callbacks) {
            this.callbacks[eventType].push(callback);
        } else {
            logger.error('Unknown event type:', eventType);
        }
    }

    async close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            logger.info('WebSocket connection closed');
        }
    }
}

module.exports = PumpPortalClient; 