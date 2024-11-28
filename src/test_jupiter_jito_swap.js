require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { JitoJsonRpcClient } = require('jito-js-rpc');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const logger = require('./logger');

class JupiterJitoSwapTester {
    constructor() {
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }
        if (!process.env.SOLANA_RPC_URL) {
            throw new Error('SOLANA_RPC_URL environment variable is required');
        }

        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.wallet = new Wallet(
            Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
        );

        this.jitoClient = new JitoJsonRpcClient('https://mainnet.block-engine.jito.wtf/api/v1');
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_DECIMALS = 6;
        this.JITO_TIP_AMOUNT = 1000000; // 0.001 SOL in lamports
    }

    async getQuote(inputMint, outputMint, amount) {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
        logger.info(`Fetching quote from: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to get quote: ${response.statusText}`);
        }

        const data = await response.json();
        logger.info('Quote received:', data);
        return data;
    }

    async executeSwap(quoteResponse) {
        logger.info('Preparing swap transaction with Jito tips...');
        
        // Get random Jito tip account
        const randomTipAccount = await this.jitoClient.getRandomTipAccount();
        const jitoTipAccount = new PublicKey(randomTipAccount);
        
        const { swapTransaction, lastValidBlockHeight } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicSlippage: { maxBps: 300 },
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        jitoTipLamports: this.JITO_TIP_AMOUNT
                    }
                }),
            })
        ).json();

        logger.info('Deserializing transaction...');
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(swapTransaction, 'base64')
        );

        logger.info('Signing transaction...');
        transaction.sign([this.wallet.payer]);
        
        logger.info('Simulating transaction...');
        const { value: simulatedResponse } = await this.connection.simulateTransaction(
            transaction,
            { replaceRecentBlockhash: true, commitment: 'processed' }
        );

        if (simulatedResponse.err) {
            logger.error('Simulation failed:', simulatedResponse);
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulatedResponse.err)}`);
        }

        logger.info('Simulation successful, sending transaction to Jito...');
        
        // Serialize and base58 encode the transaction for Jito
        const serializedTransaction = transaction.serialize();
        const base58Transaction = bs58.encode(serializedTransaction);

        try {
            const result = await this.jitoClient.sendTxn([base58Transaction], false);
            const txid = result.result;
            logger.info(`Transaction sent via Jito: ${txid}`);

            const confirmation = await this.connection.confirmTransaction({
                signature: txid,
                blockhash: transaction.message.recentBlockhash,
                lastValidBlockHeight: lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            logger.info('Transaction confirmed successfully');
            logger.info(`Transaction URL: https://solscan.io/tx/${txid}`);
            return txid;

        } catch (error) {
            logger.error('Failed to send transaction via Jito:', error);
            throw error;
        }
    }

    async testSwap(tokenAddress, amountUSD = 0.03) {
        try {
            logger.info('='.repeat(50));
            logger.info('Starting Jupiter Swap Test with Jito Tips');
            logger.info('='.repeat(50));
            
            const amount = Math.floor(amountUSD * Math.pow(10, this.USDC_DECIMALS));
            logger.info(`Testing swap of ${amountUSD} USD to token ${tokenAddress}`);
            
            const quote = await this.getQuote(
                this.SOL_MINT,
                tokenAddress,
                amount
            );

            const txid = await this.executeSwap(quote);
            
            logger.info('='.repeat(50));
            logger.info('Swap Test Results:');
            logger.info(`Amount: ${amountUSD} USD`);
            logger.info(`Transaction ID: ${txid}`);
            logger.info(`Explorer URL: https://solscan.io/tx/${txid}`);
            logger.info('='.repeat(50));

        } catch (error) {
            logger.error('Swap test failed:', error);
            throw error;
        }
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node test_jupiter_jito_swap.js <token_address> [amount_usd]');
        process.exit(1);
    }

    const [tokenAddress, amountUSD] = args;
    const tester = new JupiterJitoSwapTester();
    tester.testSwap(tokenAddress, parseFloat(amountUSD) || 0.1)
        .catch(error => {
            console.error('Test failed:', error);
            process.exit(1);
        });
}

module.exports = JupiterJitoSwapTester; 