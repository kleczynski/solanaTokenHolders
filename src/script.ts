import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';


interface OutputData {
    timestamp: string;
    summary: {
        totalHolders: number;
        minTokensRequired: number;
    };
    holders: Array<{
        rank: number;
        address: string;
        tokenCount: number;
        totalValueUsd: number;
        holdings: Array<{
            tokenAddress: string;
            amount: number;
            valueUsd: number;
        }>;
    }>;
}

interface TokenAccount {
    address: string;
    mint: string;
    owner: string;
    amount: number;
}

interface TokenInfo {
    address: string;
    priceUsd: number;  // New field for token price
}

interface TokenHolder {
    address: string;
    amount: number;
    valueUsd?: number;  // New field for USD value
}

interface HolderSummary {
    address: string;
    tokenCount: number;
    holdings: Map<string, TokenHolder>;  // Updated to store TokenHolder instead of just number
    totalValueUsd: number;  // New field for total portfolio value
}

// Rate limiter class to manage API requests
class RateLimiter {
    private queue: Array<() => Promise<any>> = [];
    private processing: boolean = false;
    private lastRequestTime: number = 0;
    private requestsInLastSecond: number = 0;
    private readonly MAX_REQUESTS_PER_SECOND = 8; // Setting to 8 to have safety margin
    private readonly MIN_TIME_BETWEEN_REQUESTS = 1000 / this.MAX_REQUESTS_PER_SECOND;

    async addToQueue<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            
            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    private async processQueue() {
        if (this.queue.length === 0) {
            this.processing = false;
            return;
        }

        this.processing = true;
        const now = Date.now();
        
        // Check if we need to wait before making the next request
        if (this.requestsInLastSecond >= this.MAX_REQUESTS_PER_SECOND) {
            const timeToWait = 1000 - (now - this.lastRequestTime);
            if (timeToWait > 0) {
                await new Promise(resolve => setTimeout(resolve, timeToWait));
                this.requestsInLastSecond = 0;
            }
        }

        // If it's been more than a second since the last request, reset counter
        if (now - this.lastRequestTime >= 1000) {
            this.requestsInLastSecond = 0;
        }

        const task = this.queue.shift();
        if (task) {
            this.requestsInLastSecond++;
            this.lastRequestTime = Date.now();
            
            await task();
            
            // Add minimum delay between requests
            await new Promise(resolve => setTimeout(resolve, this.MIN_TIME_BETWEEN_REQUESTS));
            
            // Process next item in queue
            this.processQueue();
        }
    }
}

async function saveOutputToFiles(
    qualifiedHolders: HolderSummary[], 
    tokens: TokenInfo[], 
    minTokensRequired: number,
    outputDir: string = 'output'
) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    await fs.mkdir(outputDir, { recursive: true });
    
    // Add helper function for formatting dollar values
    const formatDollarValue = (value: number): string => {
        if (value >= 1000000) {
            // For values >= 1M, show one decimal place
            return `$${(value / 1000000).toLocaleString('en-US', {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1
            })}M`;
        } else if (value >= 1000) {
            // For values >= 1K, show one decimal place
            return `$${(value / 1000).toLocaleString('en-US', {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1
            })}K`;
        } else {
            // For smaller values, show two decimal places
            return `$${value.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })}`;
        }
    };
    
    let textOutput = `Token Holdings Report - ${new Date().toLocaleString()}\n`;
    textOutput += `Found ${qualifiedHolders.length} addresses that hold at least ${minTokensRequired} tokens\n`;
    textOutput += 'Sorted by total portfolio value (highest to lowest):\n\n';
    
    const jsonOutput: OutputData = {
        timestamp: new Date().toISOString(),
        summary: {
            totalHolders: qualifiedHolders.length,
            minTokensRequired
        },
        holders: []
    };
    
    qualifiedHolders.forEach((holder, index) => {
        textOutput += `Rank #${index + 1}\n`;
        textOutput += `Holder: ${holder.address}\n`;
        textOutput += `Number of tokens held: ${holder.tokenCount}\n`;
        textOutput += `Total portfolio value: ${formatDollarValue(holder.totalValueUsd)}\n\n`;
        
        const holderHoldings: Array<{
            tokenAddress: string;
            amount: number;
            valueUsd: number;
        }> = [];
        
        tokens.forEach(token => {
            const holding = holder.holdings.get(token.address);
            
            holderHoldings.push({
                tokenAddress: token.address,
                amount: holding?.amount || 0,
                valueUsd: holding?.valueUsd || 0
            });
            
            textOutput += holding
                ? `Token ${token.address}: ${holding.amount.toLocaleString()} tokens` +
                  ` (Value: ${formatDollarValue(holding.valueUsd || 0)})\n`
                : `Token ${token.address}: 0 tokens (Value: $0.00)\n`;
        });
        
        jsonOutput.holders.push({
            rank: index + 1,
            address: holder.address,
            tokenCount: holder.tokenCount,
            totalValueUsd: holder.totalValueUsd,
            holdings: holderHoldings
        });
        
        textOutput += '-'.repeat(80) + '\n\n';
    });
    
    const textFilePath = path.join(outputDir, `holdings-report-${timestamp}.txt`);
    const jsonFilePath = path.join(outputDir, `holdings-report-${timestamp}.json`);
    
    await Promise.all([
        fs.writeFile(textFilePath, textOutput, 'utf8'),
        fs.writeFile(jsonFilePath, JSON.stringify(jsonOutput, null, 2), 'utf8')
    ]);
    
    return {
        textFilePath,
        jsonFilePath
    };
}

const rateLimiter = new RateLimiter();

async function getTokenHolders(heliusApiKey: string, mintAddress: string, priceUsd: number): Promise<TokenHolder[]> {
    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const holders = new Map<string, TokenHolder>();
    let page = 1;

    try {
        while (true) {
            console.log(`Fetching page ${page} for token ${mintAddress}...`);
            
            const response = await rateLimiter.addToQueue(() => 
                fetch(url, {
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
                })
            );

            if (!response.ok) {
                if (response.status === 429) {
                    console.log('Rate limit reached, waiting before retry...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                throw new Error(`Error: ${response.status}, ${response.statusText}`);
            }

            const data = await response.json();
            
            if (!data.result || data.result.token_accounts.length === 0) {
                break;
            }

            data.result.token_accounts.forEach((account: TokenAccount) => {
                const currentHolder = holders.get(account.owner);
                const newAmount = (currentHolder?.amount || 0) + account.amount;
                holders.set(account.owner, {
                    address: account.owner,
                    amount: newAmount,
                    valueUsd: newAmount * priceUsd
                });
            });

            page++;
        }

        return Array.from(holders.values())
            .sort((a, b) => b.amount - a.amount);

    } catch (error) {
        console.error('Error fetching token holders:', error);
        throw error;
    }
}

async function findHoldersWithMinTokens(
    heliusApiKey: string, 
    tokens: TokenInfo[], 
    minTokensRequired: number
): Promise<{
    qualifiedHolders: HolderSummary[],
    holderDetails: Map<string, TokenHolder[]>
}> {
    try {
        console.log(`Fetching holders for ${tokens.length} tokens (minimum ${minTokensRequired} required)...`);
        
        if (minTokensRequired > tokens.length) {
            throw new Error('Minimum tokens required cannot exceed total number of tokens');
        }
        
        const holderDetails = new Map<string, TokenHolder[]>();
        const holderCounts = new Map<string, HolderSummary>();
        
        for (const token of tokens) {
            const holders = await getTokenHolders(heliusApiKey, token.address, token.priceUsd);
            holderDetails.set(token.address, holders);
            
            holders.forEach(holder => {
                if (!holderCounts.has(holder.address)) {
                    holderCounts.set(holder.address, {
                        address: holder.address,
                        tokenCount: 0,
                        holdings: new Map(),
                        totalValueUsd: 0
                    });
                }
                
                const summary = holderCounts.get(holder.address)!;
                summary.tokenCount++;
                summary.holdings.set(token.address, holder);
                summary.totalValueUsd += holder.valueUsd || 0;
            });
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const qualifiedHolders = Array.from(holderCounts.values())
            .filter(summary => summary.tokenCount >= minTokensRequired)
            .sort((a, b) => b.totalValueUsd - a.totalValueUsd);  // Sort by total value

        return {
            qualifiedHolders,
            holderDetails
        };
    } catch (error) {
        console.error('Error finding holders with minimum tokens:', error);
        throw error;
    }
}

async function main() {
    const HELIUS_API_KEY = 'YOUR_HELIUS_API_KEY';
    
    try {
        const tokens: TokenInfo[] = [
            {
                address: '3B5wuUrMEi5yATD7on46hKfej3pfmd7t1RKgrsN3pump',
                priceUsd: 0.0021
            },
            {
                address: 'GYKmdfcUmZVrqfcH1g579BGjuzSRijj3LBuwv79rpump',
                priceUsd: 0.0025
            },
            {
                address: 'GRFK7sv4KhkMzJ7BXDUBy4PLyZVBeXuW1FeaT6Mnpump',
                priceUsd: 0.0010
            }
        ];
        
        const minTokensRequired = 3;
        
        const { qualifiedHolders } = await findHoldersWithMinTokens(
            HELIUS_API_KEY, 
            tokens, 
            minTokensRequired
        );
        
        // Save to files and get file paths
        const { textFilePath, jsonFilePath } = await saveOutputToFiles(
            qualifiedHolders,
            tokens,
            minTokensRequired
        );
        
        console.log('Reports generated successfully:');
        console.log(`Text report: ${textFilePath}`);
        console.log(`JSON report: ${jsonFilePath}`);
        
    } catch (error) {
        console.error('Error:', error);
    }
}

main();