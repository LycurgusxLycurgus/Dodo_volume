const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('./logger');

class PumpPortalClient extends EventEmitter {
    constructor() {
        super();
        this.uri = "wss://pumpportal.fun/api/data";
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
                this.ws = new WebSocket(this.uri);

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

    async subscribeAccountTrade(accountAddresses) {
        const newAccounts = accountAddresses.filter(addr => !this.subscribedAccounts.has(addr));
        if (newAccounts.length > 0) {
            await this._sendMessage({
                method: "subscribeAccountTrade",
                keys: newAccounts
            });
            newAccounts.forEach(account => this.subscribedAccounts.add(account));
            logger.info(`Subscribed to trades for accounts: ${newAccounts.join(', ')}`);
        }
    }

    async unsubscribeNewToken() {
        await this._sendMessage({ method: "unsubscribeNewToken" });
        logger.info('Unsubscribed from new token events');
    }

    async unsubscribeTokenTrade(tokenAddresses) {
        await this._sendMessage({
            method: "unsubscribeTokenTrade",
            keys: tokenAddresses
        });
        tokenAddresses.forEach(token => this.subscribedTokens.delete(token));
        logger.info(`Unsubscribed from trades for tokens: ${tokenAddresses.join(', ')}`);
    }

    async unsubscribeAccountTrade(accountAddresses) {
        await this._sendMessage({
            method: "unsubscribeAccountTrade",
            keys: accountAddresses
        });
        accountAddresses.forEach(account => this.subscribedAccounts.delete(account));
        logger.info(`Unsubscribed from trades for accounts: ${accountAddresses.join(', ')}`);
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