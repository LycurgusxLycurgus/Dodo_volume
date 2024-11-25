const PumpPortalClient = require('../pump_portal');
const logger = require('../logger');
const WebSocket = require('ws');

// Mock WebSocket to avoid actual connections during tests
jest.mock('ws');

// Mock logger
jest.mock('../logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('PumpPortalClient', () => {
    let client;
    let mockWs;
    let mockMessageCallback;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Create mock WebSocket instance
        mockWs = {
            on: jest.fn(),
            send: jest.fn(),
            close: jest.fn(),
            terminate: jest.fn()
        };
        
        // Make WebSocket constructor return our mock
        WebSocket.mockImplementation(() => mockWs);
        
        // Create client instance
        client = new PumpPortalClient();
        mockMessageCallback = jest.fn();
    });

    afterEach(() => {
        client.close();
    });

    describe('New Token Monitoring', () => {
        test('should successfully subscribe to new token events', async () => {
            // Setup
            const mockNewTokenCallback = jest.fn();
            
            // Simulate successful connection
            client.connect();
            // Get the 'open' callback and call it
            const openCallback = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
            openCallback();

            // Subscribe to new token events
            await client.subscribeNewToken();

            // Verify subscription message was sent
            expect(mockWs.send).toHaveBeenCalledWith(
                JSON.stringify({ method: "subscribeNewToken" })
            );

            // Simulate receiving a new token event
            const mockTokenData = {
                type: 'new_token',
                token: {
                    address: 'TokenAddress123',
                    name: 'Test Token',
                    symbol: 'TEST'
                }
            };

            // Get the message callback and simulate receiving data
            const messageCallback = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
            messageCallback(JSON.stringify(mockTokenData));

            // Verify event was emitted
            expect(client.isConnected).toBe(true);
            expect(logger.info).toHaveBeenCalledWith('Subscribed to new token events');
        });
    });

    describe('Token Trade Monitoring', () => {
        test('should successfully monitor specific tokens', async () => {
            // Setup
            const tokenAddresses = ['token1', 'token2'];
            
            // Simulate successful connection
            client.connect();
            const openCallback = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
            openCallback();

            // Subscribe to token trades
            await client.subscribeTokenTrade(tokenAddresses);

            // Verify subscription message
            expect(mockWs.send).toHaveBeenCalledWith(
                JSON.stringify({
                    method: "subscribeTokenTrade",
                    keys: tokenAddresses
                })
            );

            // Simulate receiving a trade event
            const mockTradeData = {
                type: 'token_trade',
                trade: {
                    tokenAddress: 'token1',
                    amount: '1000',
                    price: '0.1'
                }
            };

            const messageCallback = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
            messageCallback(JSON.stringify(mockTradeData));

            expect(client.subscribedTokens.size).toBe(2);
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Subscribed to trades for tokens'));
        });
    });

    describe('Account Trade Monitoring', () => {
        test('should successfully monitor specific accounts', async () => {
            // Setup
            const accountAddresses = ['account1', 'account2'];
            
            // Simulate successful connection
            client.connect();
            const openCallback = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
            openCallback();

            // Subscribe to account trades
            await client.subscribeAccountTrade(accountAddresses);

            // Verify subscription message
            expect(mockWs.send).toHaveBeenCalledWith(
                JSON.stringify({
                    method: "subscribeAccountTrade",
                    keys: accountAddresses
                })
            );

            // Simulate receiving a trade event
            const mockTradeData = {
                type: 'account_trade',
                trade: {
                    account: 'account1',
                    tokenAddress: 'token1',
                    amount: '1000'
                }
            };

            const messageCallback = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
            messageCallback(JSON.stringify(mockTradeData));

            expect(client.subscribedAccounts.size).toBe(2);
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Subscribed to trades for accounts'));
        });
    });

    describe('Event Handling', () => {
        test('should handle multiple subscriptions and events', async () => {
            // Setup
            client.connect();
            const openCallback = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
            openCallback();

            // Subscribe to multiple event types
            await client.subscribeNewToken();
            await client.subscribeTokenTrade(['token1']);
            await client.subscribeAccountTrade(['account1']);

            // Verify all subscriptions were sent
            expect(mockWs.send).toHaveBeenCalledTimes(3);

            // Simulate receiving different types of events
            const messageCallback = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];

            const events = [
                {
                    type: 'new_token',
                    token: { address: 'newToken', name: 'New Token' }
                },
                {
                    type: 'token_trade',
                    trade: { tokenAddress: 'token1', amount: '1000' }
                },
                {
                    type: 'account_trade',
                    trade: { account: 'account1', amount: '500' }
                }
            ];

            // Simulate receiving each event
            events.forEach(event => {
                messageCallback(JSON.stringify(event));
            });

            expect(client.isConnected).toBe(true);
        });
    });
}); 