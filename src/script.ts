import fetch from 'node-fetch';

interface TokenAccount {
    address: string;
    mint: string;
    owner: string;
    amount: number;
}

interface TokenHolder {
    address: string;
    amount: number;
}

async function getTokenHolders(heliusApiKey: string, mintAddress: string): Promise<TokenHolder[]> {
    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const holders = new Map<string, number>();
    let page = 1;

    try {
        while (true) {
            console.log(`Fetching page ${page} for token ${mintAddress}...`);
            
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'getTokenAccounts',
                    id: 'helius-test',
                    params: {
                        page: page,
                        limit: 1000,
                        displayOptions: {},
                        mint: mintAddress,
                    },
                }),
            });

            if (!response.ok) {
                throw new Error(`Error: ${response.status}, ${response.statusText}`);
            }

            const data = await response.json();
            
            if (!data.result || data.result.token_accounts.length === 0) {
                console.log(`No more results for ${mintAddress}. Total pages processed: ${page - 1}`);
                break;
            }

            data.result.token_accounts.forEach((account: TokenAccount) => {
                const currentAmount = holders.get(account.owner) || 0;
                holders.set(account.owner, currentAmount + account.amount);
            });

            page++;
        }

        const holderArray = Array.from(holders.entries()).map(([address, amount]) => ({
            address,
            amount
        }));

        holderArray.sort((a, b) => b.amount - a.amount);
        return holderArray;

    } catch (error) {
        console.error('Error fetching token holders:', error);
        throw error;
    }
}

async function findCommonHolders(heliusApiKey: string, tokenAddresses: string[]): Promise<{
    commonHolders: string[],
    holderDetails: Map<string, TokenHolder[]>
}> {
    try {
        console.log('Fetching holders for multiple tokens...');
        
        // Store all holder details for each token
        const holderDetails = new Map<string, TokenHolder[]>();
        
        // Get holders for all tokens
        const holdersArrays = await Promise.all(
            tokenAddresses.map(async (mintAddress) => {
                const holders = await getTokenHolders(heliusApiKey, mintAddress);
                holderDetails.set(mintAddress, holders);
                return new Set(holders.map(h => h.address));
            })
        );

        // Find intersection of all holder sets
        let commonHolders = [...holdersArrays[0]];
        for (let i = 1; i < holdersArrays.length; i++) {
            commonHolders = commonHolders.filter(holder => 
                holdersArrays[i].has(holder)
            );
        }

        return {
            commonHolders,
            holderDetails
        };
    } catch (error) {
        console.error('Error finding common holders:', error);
        throw error;
    }
}

// Example usage
async function main() {
    const HELIUS_API_KEY = 'YOUR_API_KEY';
    
    try {
        // Define the token addresses you want to check
        const tokenAddresses = [
            '3B5wuUrMEi5yATD7on46hKfej3pfmd7t1RKgrsN3pump',  // First token
            'GYKmdfcUmZVrqfcH1g579BGjuzSRijj3LBuwv79rpump',  // Second token
            'GRFK7sv4KhkMzJ7BXDUBy4PLyZVBeXuW1FeaT6Mnpump',
            'FkBF9u1upwEMUPxnXjcydxxVSxgr8f3k1YXbz7G7bmtA'
        ];
        
        const { commonHolders, holderDetails } = await findCommonHolders(HELIUS_API_KEY, tokenAddresses);
        
        console.log(`Found ${commonHolders.length} addresses that hold all tokens`);
        
        // Print detailed information for each common holder
        commonHolders.forEach(holderAddress => {
            console.log(`\nHolder: ${holderAddress}`);
            tokenAddresses.forEach(tokenMint => {
                const holderInfo = holderDetails.get(tokenMint)?.find(h => h.address === holderAddress);
                console.log(`Token ${tokenMint}: ${holderInfo?.amount || 0} tokens`);
            });
        });

        console.log("Common Holders Lenght: ", commonHolders.length);
        
    } catch (error) {
        console.error('Error:', error);
    }
}

main();