Transaction confirmation tips #
As mentioned before, blockhashes expire after a time period of only 151 blocks which can pass as quickly as one minute when slots are processed within the target time of 400ms.

One minute is not a lot of time considering that a client needs to fetch a recent blockhash, wait for the user to sign, and finally hope that the broadcasted transaction reaches a leader that is willing to accept it. Let's go through some tips to help avoid confirmation failures due to transaction expiration!

Fetch blockhashes with the appropriate commitment level #
Given the short expiration time frame, it's imperative that clients and applications help users create transactions with a blockhash that is as recent as possible.

When fetching blockhashes, the current recommended RPC API is called getLatestBlockhash. By default, this API uses the finalized commitment level to return the most recently finalized block's blockhash. However, you can override this behavior by setting the commitment parameter to a different commitment level.

Recommendation

The confirmed commitment level should almost always be used for RPC requests because it's usually only a few slots behind the processed commitment and has a very low chance of belonging to a dropped fork.

But feel free to consider the other options:

Choosing processed will let you fetch the most recent blockhash compared to other commitment levels and therefore gives you the most time to prepare and process a transaction. But due to the prevalence of forking in the Solana blockchain, roughly 5% of blocks don't end up being finalized by the cluster so there's a real chance that your transaction uses a blockhash that belongs to a dropped fork. Transactions that use blockhashes for abandoned blocks won't ever be considered recent by any blocks that are in the finalized blockchain.
Using the default commitment level finalized will eliminate any risk that the blockhash you choose will belong to a dropped fork. The tradeoff is that there is typically at least a 32 slot difference between the most recent confirmed block and the most recent finalized block. This tradeoff is pretty severe and effectively reduces the expiration of your transactions by about 13 seconds but this could be even more during unstable cluster conditions.
Use an appropriate preflight commitment level #
If your transaction uses a blockhash that was fetched from one RPC node then you send, or simulate, that transaction with a different RPC node, you could run into issues due to one node lagging behind the other.

When RPC nodes receive a sendTransaction request, they will attempt to determine the expiration block of your transaction using the most recent finalized block or with the block selected by the preflightCommitment parameter. A VERY common issue is that a received transaction's blockhash was produced after the block used to calculate the expiration for that transaction. If an RPC node can't determine when your transaction expires, it will only forward your transaction one time and afterwards will then drop the transaction.

Similarly, when RPC nodes receive a simulateTransaction request, they will simulate your transaction using the most recent finalized block or with the block selected by the preflightCommitment parameter. If the block chosen for simulation is older than the block used for your transaction's blockhash, the simulation will fail with the dreaded “blockhash not found” error.

Recommendation

Even if you use skipPreflight, ALWAYS set the preflightCommitment parameter to the same commitment level used to fetch your transaction's blockhash for both sendTransaction and simulateTransaction requests.

Be wary of lagging RPC nodes when sending transactions #
When your application uses an RPC pool service or when the RPC endpoint differs between creating a transaction and sending a transaction, you need to be wary of situations where one RPC node is lagging behind the other. For example, if you fetch a transaction blockhash from one RPC node then you send that transaction to a second RPC node for forwarding or simulation, the second RPC node might be lagging behind the first.

Recommendation

For sendTransaction requests, clients should keep resending a transaction to a RPC node on a frequent interval so that if an RPC node is slightly lagging behind the cluster, it will eventually catch up and detect your transaction's expiration properly.

For simulateTransaction requests, clients should use the replaceRecentBlockhash parameter to tell the RPC node to replace the simulated transaction's blockhash with a blockhash that will always be valid for simulation.

Avoid reusing stale blockhashes #
Even if your application has fetched a very recent blockhash, be sure that you're not reusing that blockhash in transactions for too long. The ideal scenario is that a recent blockhash is fetched right before a user signs their transaction.

Recommendation for applications

Poll for new recent blockhashes on a frequent basis to ensure that whenever a user triggers an action that creates a transaction, your application already has a fresh blockhash that's ready to go.

Recommendation for wallets

Poll for new recent blockhashes on a frequent basis and replace a transaction's recent blockhash right before they sign the transaction to ensure the blockhash is as fresh as possible.

Use healthy RPC nodes when fetching blockhashes #
By fetching the latest blockhash with the confirmed commitment level from an RPC node, it's going to respond with the blockhash for the latest confirmed block that it's aware of. Solana's block propagation protocol prioritizes sending blocks to staked nodes so RPC nodes naturally lag about a block behind the rest of the cluster. They also have to do more work to handle application requests and can lag a lot more under heavy user traffic.

Lagging RPC nodes can therefore respond to getLatestBlockhash requests with blockhashes that were confirmed by the cluster quite awhile ago. By default, a lagging RPC node detects that it is more than 150 slots behind the cluster will stop responding to requests, but just before hitting that threshold they can still return a blockhash that is just about to expire.

Recommendation

Monitor the health of your RPC nodes to ensure that they have an up-to-date view of the cluster state with one of the following methods:

Fetch your RPC node's highest processed slot by using the getSlot RPC API with the processed commitment level and then call the getMaxShredInsertSlot RPC API to get the highest slot that your RPC node has received a “shred” of a block for. If the difference between these responses is very large, the cluster is producing blocks far ahead of what the RPC node has processed.
Call the getLatestBlockhash RPC API with the confirmed commitment level on a few different RPC API nodes and use the blockhash from the node that returns the highest slot for its context slot.
Wait long enough for expiration #
Recommendation

When calling the getLatestBlockhash RPC API to get a recent blockhash for your transaction, take note of the lastValidBlockHeight in the response.

Then, poll the getBlockHeight RPC API with the confirmed commitment level until it returns a block height greater than the previously returned last valid block height.

Consider using “durable” transactions #
Sometimes transaction expiration issues are really hard to avoid (e.g. offline signing, cluster instability). If the previous tips are still not sufficient for your use-case, you can switch to using durable transactions (they just require a bit of setup).

To start using durable transactions, a user first needs to submit a transaction that invokes instructions that create a special on-chain “nonce” account and stores a “durable blockhash” inside of it. At any point in the future (as long as the nonce account hasn't been used yet), the user can create a durable transaction by following these 2 rules:

The instruction list must start with an “advance nonce” system instruction which loads their on-chain nonce account
The transaction's blockhash must be equal to the durable blockhash stored by the on-chain nonce account
Here's how these durable transactions are processed by the Solana runtime:

If the transaction's blockhash is no longer “recent”, the runtime checks if the transaction's instruction list begins with an “advance nonce” system instruction
If so, it then loads the nonce account specified by the “advance nonce” instruction
Then it checks that the stored durable blockhash matches the transaction's blockhash
Lastly it makes sure to advance the nonce account's stored blockhash to the latest recent blockhash to ensure that the same transaction can never be processed again
For more details about how these durable transactions work, you can read the original proposal and check out an example in the Solana docs.