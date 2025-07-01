/**
 * ArtistWorker: Handles complete workflow for a single artist in parallel processing
 * WorkerPool: Manages multiple workers for parallel artist processing
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { TwitterAuth } from '../pageObjects/TwitterAuth';
import { TwitterScraper } from '../pageObjects/TwitterScraper';
import { Logger } from './Logger';
import { AuthCredentials, ScraperConfig, DownloadStats } from '../interfaces/ScraperTypes';
import { GoogleDriveUploader } from './GoogleDriveUploader';

export enum ProcessingMode {
    DISTRIBUTED = 'distributed',      // Current method - distribute artists across workers
    MAX_CONCURRENT = 'max_concurrent', // All workers grab next available artist
    BATCHED = 'batched'               // Process in controlled batches
}

export interface WorkerResult {
    artist: string;
    success: boolean;
    stats: DownloadStats;
    error?: string;
    uploadResult?: {
        successful: number;
        failed: number;
        skipped: number;
        total: number;
    };
}

export class ArtistWorker {
    private workerId: number;
    private browser: Browser;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private logger: Logger;
    private scraperConfig: ScraperConfig;
    private googleDriveUploader: GoogleDriveUploader | null;
    private sharedAuthState: string | null;

    constructor(
        workerId: number,
        browser: Browser,
        scraperConfig: ScraperConfig,
        sharedAuthState: string | null = null,
        googleDriveUploader: GoogleDriveUploader | null = null
    ) {
        this.workerId = workerId;
        this.browser = browser;
        this.logger = Logger.getInstance();
        this.scraperConfig = scraperConfig;
        this.googleDriveUploader = googleDriveUploader;
        this.sharedAuthState = sharedAuthState;

        if (googleDriveUploader) {
            this.logger.info(`Worker ${workerId}: Creating individual GoogleDriveUploader instance`);
            // We need to create a new instance per worker to avoid statistics conflicts
            // This requires access to the original config - we'll need to pass this differently
            this.googleDriveUploader = googleDriveUploader; // For now, use shared instance but this might be the bug
        } else {
            this.googleDriveUploader = null;
        }
    }

    /**
     * Initialize worker with shared authentication state
     */
    public async initialize(): Promise<void> {
        try {
            this.logger.info(`Worker ${this.workerId}: Initializing with shared auth state`);
            
            // Create context with shared authentication state
            if (this.sharedAuthState) {
                this.context = await this.browser.newContext({
                    storageState: this.sharedAuthState,
                    viewport: { width: 1280, height: 800 },
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                });
            } else {
                this.context = await this.browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                });
            }
            
            this.page = await this.context.newPage();
            
            this.logger.info(`Worker ${this.workerId}: Browser context initialized`);
        } catch (error) {
            this.logger.error(`Worker ${this.workerId}: Failed to initialize`, error as Error);
            throw error;
        }
    }

    /**
     * Process a single artist through complete workflow
     */
    public async processArtist(artist: string): Promise<WorkerResult> {
        if (!this.context || !this.page) {
            throw new Error(`Worker ${this.workerId}: Not initialized`);
        }

        this.logger.info(`Worker ${this.workerId}: Starting processing for @${artist}`);
        
        try {
            // Initialize scraper directly - authentication should already be handled
            const twitterScraper = new TwitterScraper(
                this.page,
                this.context,
                this.browser,
                this.scraperConfig
            );
            
            // Set the worker ID for better logging
            twitterScraper.setWorkerContext(this.workerId, artist);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(artist);
            
            // Check if account is accessible
            if (await twitterScraper.isPrivateAccount()) {
                this.logger.warn(`Worker ${this.workerId}: @${artist} is private, skipping`);
                return {
                    artist,
                    success: true,
                    stats: { 
                        total: 0, 
                        successful: 0, 
                        failed: 0, 
                        skipped: 0,
                        byType: { images: 0, videos: 0, gifs: 0 }
                    },
                    error: 'Account is private'
                };
            }
            
            if (await twitterScraper.isSuspendedAccount()) {
                this.logger.warn(`Worker ${this.workerId}: @${artist} is suspended, skipping`);
                return {
                    artist,
                    success: true,
                    stats: { 
                        total: 0, 
                        successful: 0, 
                        failed: 0, 
                        skipped: 0,
                        byType: { images: 0, videos: 0, gifs: 0 }
                    },
                    error: 'Account is suspended'
                };
            }
            
            // Scroll and load media
            const imageCount = await twitterScraper.scrollAndLoadMedia();
            this.logger.info(`Worker ${this.workerId}: Found ${imageCount} images for @${artist}`);
            
            // Extract image URLs
            const mediaDataList = await twitterScraper.extractMediaUrls();

            if (mediaDataList.length === 0) {
                this.logger.warn(`Worker ${this.workerId}: No media found for @${artist}`);
                return {
                    artist,
                    success: true,
                    stats: { total: 0, successful: 0, failed: 0, skipped: 0, byType: { images: 0, videos: 0, gifs: 0 } },
                    error: 'No media found'
                };
            }
            
            // Download images
            this.logger.info(`Worker ${this.workerId}: Downloading ${mediaDataList.length} images for @${artist}`);
            const downloadResult = await twitterScraper.downloadImages(mediaDataList);
            
            let uploadResult = undefined;
            
            // Upload to Google Drive if enabled and we have downloaded files
            if (this.googleDriveUploader && downloadResult.downloadedPaths.length > 0) {
                try {
                    this.logger.info(`Worker ${this.workerId}: Uploading ${downloadResult.downloadedPaths.length} images for @${artist}`);
                    
                    // Debug: Log what we're about to upload
                    this.logger.info(`Worker ${this.workerId}: About to upload ${downloadResult.downloadedPaths.length} files for @${artist}`);
                    
                    uploadResult = await this.googleDriveUploader.batchUpload(downloadResult.downloadedPaths, artist);
                    
                    // Debug: Log the upload result details
                    this.logger.info(`Worker ${this.workerId}: Upload result for @${artist}: ${JSON.stringify(uploadResult)}`);
                    
                    // Verify upload result makes sense
                    if (uploadResult.successful + uploadResult.failed + uploadResult.skipped !== uploadResult.total) {
                        this.logger.warn(`Worker ${this.workerId}: Upload statistics inconsistent for @${artist}: ` +
                            `${uploadResult.successful} + ${uploadResult.failed} + ${uploadResult.skipped} != ${uploadResult.total}`);
                    }
                    
                    this.logger.success(`Worker ${this.workerId}: Upload completed for @${artist}: ${uploadResult.successful}/${uploadResult.total} successful`);
                } catch (error) {
                    this.logger.error(`Worker ${this.workerId}: Upload failed for @${artist}`, error as Error);
                    // Continue execution - upload failure shouldn't fail the entire worker
                }
            }
            
            this.logger.success(`Worker ${this.workerId}: Completed processing @${artist} - Downloaded: ${downloadResult.stats.successful}/${downloadResult.stats.total}`);
            
            return {
                artist,
                success: true,
                stats: downloadResult.stats,
                uploadResult
            };
            
        } catch (error) {
            this.logger.error(`Worker ${this.workerId}: Failed processing @${artist}`, error as Error);
            return {
                artist,
                success: false,
                stats: { 
                    total: 0, 
                    successful: 0, 
                    failed: 0, 
                    skipped: 0,
                    byType: { images: 0, videos: 0, gifs: 0 }
                },
                error: (error as Error).message
            };
        }
    }

    /**
     * Clean up worker resources
     */
    public async cleanup(): Promise<void> {
        try {
            this.logger.info(`Worker ${this.workerId}: Cleaning up resources`);
            
            if (this.page) {
                await this.page.close();
                this.page = null;
            }
            
            if (this.context) {
                await this.context.close();
                this.context = null;
            }
            
            this.logger.info(`Worker ${this.workerId}: Cleanup completed`);
        } catch (error) {
            this.logger.error(`Worker ${this.workerId}: Cleanup failed`, error as Error);
        }
    }
}

export class WorkerPool {
    private workers: ArtistWorker[] = [];
    private browser: Browser;
    private logger: Logger;
    private authCredentials: AuthCredentials;
    private scraperConfig: ScraperConfig;
    private googleDriveUploader: GoogleDriveUploader | null;
    private maxWorkers: number;
    private sharedAuthState: string | null = null;

    constructor(
        browser: Browser,
        authCredentials: AuthCredentials,
        scraperConfig: ScraperConfig,
        googleDriveUploader: GoogleDriveUploader | null = null,
        maxWorkers: number = 3
    ) {
        this.browser = browser;
        this.logger = Logger.getInstance();
        this.authCredentials = authCredentials;
        this.scraperConfig = scraperConfig;
        this.googleDriveUploader = googleDriveUploader;
        this.maxWorkers = maxWorkers;
    }

    /**
     * Perform authentication once and share across workers
     */
    private async authenticateOnce(): Promise<void> {
        this.logger.info('Performing single authentication for all workers...');
        
        // Create temporary context for authentication
        const tempContext = await this.browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        
        const tempPage = await tempContext.newPage();
        
        try {
            // Initialize authentication
            const twitterAuth = new TwitterAuth(tempPage, tempContext, this.browser);
            
            // Perform login
            await twitterAuth.login(this.authCredentials);
            
            // Save authentication state to a temporary file for sharing
            const tempAuthPath = './temp-auth-state.json';
            await tempContext.storageState({ path: tempAuthPath });
            this.sharedAuthState = tempAuthPath;
            
            this.logger.success('Authentication completed and state saved for workers');
            
        } finally {
            // Clean up temporary resources
            await tempPage.close();
            await tempContext.close();
        }
    }

    /**
     * Initialize worker pool with shared authentication
     */
    public async initialize(): Promise<void> {
        this.logger.info(`Initializing worker pool with ${this.maxWorkers} workers`);
        
        // First, authenticate once and save state
        await this.authenticateOnce();
        
        // Create workers with shared auth state
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = new ArtistWorker(
                i + 1,
                this.browser,
                this.scraperConfig,
                this.sharedAuthState,
                this.googleDriveUploader
            );
            
            await worker.initialize();
            this.workers.push(worker);
            
            // Small delay between worker initialization
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        this.logger.success(`Worker pool initialized with ${this.workers.length} workers`);
    }

    /**
     * Process a queue of artists for a single worker
     * @param worker The worker to use
     * @param artistQueue Queue of artists for this worker
     * @param workerId Worker ID for logging
     * @returns Array of results from this worker
     */
    private async processWorkerQueue(
        worker: ArtistWorker, 
        artistQueue: string[], 
        workerId: number
    ): Promise<WorkerResult[]> {
        const results: WorkerResult[] = [];
        
        if (artistQueue.length === 0) {
            this.logger.info(`Worker ${workerId}: No artists assigned`);
            return results;
        }
        
        this.logger.info(`Worker ${workerId}: Starting to process ${artistQueue.length} artists`);
        
        for (let i = 0; i < artistQueue.length; i++) {
            const artist = artistQueue[i];
            
            try {
                this.logger.info(`Worker ${workerId}: Processing @${artist} (${i + 1}/${artistQueue.length})`);
                const result = await worker.processArtist(artist);
                results.push(result);
                
                // Add delay between artists within the same worker to be respectful
                if (i < artistQueue.length - 1) {
                    this.logger.info(`Worker ${workerId}: Waiting ${this.scraperConfig.rateLimitDelay}ms before next artist`);
                    await new Promise(resolve => setTimeout(resolve, this.scraperConfig.rateLimitDelay));
                }
                
            } catch (error) {
                this.logger.error(`Worker ${workerId}: Failed to process @${artist}`, error as Error);
                results.push({
                    artist,
                    success: false,
                    stats: { 
                        total: 0, 
                        successful: 0, 
                        failed: 0, 
                        skipped: 0,
                        byType: { images: 0, videos: 0, gifs: 0 }
                    },
                    error: (error as Error).message
                });
            }
        }
        
        this.logger.success(`Worker ${workerId}: Completed processing ${artistQueue.length} artists`);
        return results;
    }

    /**
     * Process artists using distributed queues (original method)
     */
    public async processArtistsDistributed(artists: string[]): Promise<WorkerResult[]> {
        if (artists.length === 0) {
            this.logger.warn('No artists to process');
            return [];
        }

        this.logger.info(`Processing ${artists.length} artists using DISTRIBUTED mode with ${this.workers.length} workers`);
        
        // Distribute artists across workers
        const artistQueues: string[][] = [];
        for (let i = 0; i < this.maxWorkers; i++) {
            artistQueues.push([]);
        }
        
        // Round-robin distribution of artists to worker queues
        artists.forEach((artist, index) => {
            const workerIndex = index % this.maxWorkers;
            artistQueues[workerIndex].push(artist);
        });
        
        // Log distribution
        artistQueues.forEach((queue, index) => {
            this.logger.info(`Worker ${index + 1} assigned ${queue.length} artists: ${queue.join(', ')}`);
        });
        
        // Process each worker's queue concurrently
        const workerPromises = artistQueues.map((artistQueue, workerIndex) => 
            this.processWorkerQueue(this.workers[workerIndex], artistQueue, workerIndex + 1)
        );
        
        // Wait for all workers to complete
        const workerResults = await Promise.all(workerPromises);
        
        // Flatten results from all workers
        const allResults: WorkerResult[] = [];
        workerResults.forEach(results => allResults.push(...results));
        
        return allResults;
    }

    /**
     * Process artists with maximum concurrency (all workers active simultaneously)
     */
    public async processArtistsMaxConcurrency(artists: string[]): Promise<WorkerResult[]> {
        if (artists.length === 0) {
            this.logger.warn('No artists to process');
            return [];
        }

        this.logger.info(`Processing ${artists.length} artists using MAX_CONCURRENT mode with ${this.workers.length} workers`);
        
        const results: WorkerResult[] = [];
        const artistIndex = { current: 0 }; // Use object to maintain reference across async calls
        
        // Create promises for each worker to continuously process artists
        const workerPromises = this.workers.map(async (worker, workerIndex) => {
            const workerId = workerIndex + 1;
            const workerResults: WorkerResult[] = [];
            
            while (artistIndex.current < artists.length) {
                // Atomically get the next artist
                const currentIndex = artistIndex.current++;
                if (currentIndex >= artists.length) break;
                
                const artist = artists[currentIndex];
                
                try {
                    this.logger.info(`Worker ${workerId}: Processing @${artist} (${currentIndex + 1}/${artists.length})`);
                    const result = await worker.processArtist(artist);
                    workerResults.push(result);
                    
                    // Small delay to be respectful to servers
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (error) {
                    this.logger.error(`Worker ${workerId}: Failed to process @${artist}`, error as Error);
                    workerResults.push({
                        artist,
                        success: false,
                        stats: { 
                            total: 0, 
                            successful: 0, 
                            failed: 0, 
                            skipped: 0,
                            byType: { images: 0, videos: 0, gifs: 0 }
                        },
                        error: (error as Error).message
                    });
                }
            }
            
            this.logger.success(`Worker ${workerId}: Completed processing ${workerResults.length} artists`);
            return workerResults;
        });
        
        // Wait for all workers to complete
        const allWorkerResults = await Promise.all(workerPromises);
        
        // Flatten results
        allWorkerResults.forEach(workerResults => results.push(...workerResults));
        
        return results;
    }

    /**
     * Process artists in controlled batches (balanced approach)
     */
    public async processArtistsBatched(artists: string[]): Promise<WorkerResult[]> {
        if (artists.length === 0) {
            this.logger.warn('No artists to process');
            return [];
        }

        this.logger.info(`Processing ${artists.length} artists using BATCHED mode with ${this.workers.length} workers`);
        
        const results: WorkerResult[] = [];
        const batchSize = this.maxWorkers;
        
        // Process artists in batches of worker count
        for (let i = 0; i < artists.length; i += batchSize) {
            const batch = artists.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(artists.length / batchSize);
            
            this.logger.info(`Processing batch ${batchNumber}/${totalBatches} with ${batch.length} artists: ${batch.join(', ')}`);
            
            // Process current batch in parallel
            const batchPromises = batch.map((artist, index) => {
                const worker = this.workers[index];
                const workerId = index + 1;
                
                return worker.processArtist(artist).then(result => {
                    this.logger.info(`Worker ${workerId}: Completed @${artist}`);
                    return result;
                }).catch(error => {
                    this.logger.error(`Worker ${workerId}: Failed @${artist}`, error as Error);
                    return {
                        artist,
                        success: false,
                        stats: { 
                            total: 0, 
                            successful: 0, 
                            failed: 0, 
                            skipped: 0,
                            byType: { images: 0, videos: 0, gifs: 0 }
                        },
                        error: (error as Error).message
                    } as WorkerResult;
                });
            });
            
            // Wait for current batch to complete
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            // Add delay between batches if there are more to process
            if (i + batchSize < artists.length) {
                this.logger.info(`Batch ${batchNumber} completed. Waiting ${this.scraperConfig.rateLimitDelay * 2}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, this.scraperConfig.rateLimitDelay * 2));
            }
        }
        
        return results;
    }

    // Keep the original processArtists method as an alias to distributed mode
    public async processArtists(artists: string[]): Promise<WorkerResult[]> {
        return this.processArtistsDistributed(artists);
    }

    /**
     * Process artists using the specified processing mode
     * @param artists List of artists to process
     * @param mode Processing mode to use
     * @returns Array of worker results
     */
    public async processArtistsWithMode(artists: string[], mode: ProcessingMode): Promise<WorkerResult[]> {
        switch (mode) {
            case ProcessingMode.DISTRIBUTED:
                return this.processArtistsDistributed(artists);
            case ProcessingMode.MAX_CONCURRENT:
                return this.processArtistsMaxConcurrency(artists);
            case ProcessingMode.BATCHED:
                return this.processArtistsBatched(artists);
            default:
                this.logger.warn(`Unknown processing mode: ${mode}, using distributed mode`);
                return this.processArtistsDistributed(artists);
        }
    }

    /**
     * Clean up all workers and temporary files
     */
    public async cleanup(): Promise<void> {
        this.logger.info('Cleaning up worker pool');
        
        const cleanupPromises = this.workers.map(worker => worker.cleanup());
        await Promise.all(cleanupPromises);
        
        // Clean up shared auth state file
        if (this.sharedAuthState) {
            try {
                const fs = require('fs');
                if (fs.existsSync(this.sharedAuthState)) {
                    fs.unlinkSync(this.sharedAuthState);
                    this.logger.info('Cleaned up temporary auth state file');
                }
            } catch (error) {
                this.logger.error('Failed to clean up temporary auth state file', error as Error);
            }
        }
        
        this.workers = [];
        this.logger.info('Worker pool cleanup completed');
    }

    /**
     * Get aggregated statistics from all results
     */
    public static getAggregatedStats(results: WorkerResult[]): {
        totalArtists: number;
        successfulArtists: number;
        failedArtists: number;
        skippedArtists: number;
        downloadStats: DownloadStats;
        uploadStats?: {
            successful: number;
            failed: number;
            skipped: number;
            total: number;
        };
    } {
        const downloadStats: DownloadStats = {
            total: results.reduce((sum, r) => sum + (r.stats?.total || 0), 0),
            successful: results.reduce((sum, r) => sum + (r.stats?.successful || 0), 0),
            failed: results.reduce((sum, r) => sum + (r.stats?.failed || 0), 0),
            skipped: results.reduce((sum, r) => sum + (r.stats?.skipped || 0), 0),
            byType: {
                images: results.reduce((sum, r) => sum + (r.stats?.byType?.images || 0), 0),
                videos: results.reduce((sum, r) => sum + (r.stats?.byType?.videos || 0), 0),
                gifs: results.reduce((sum, r) => sum + (r.stats?.byType?.gifs || 0), 0)
            }
        };
        
        const uploadStats = { 
            total: 0, 
            successful: 0, 
            failed: 0, 
            skipped: 0,
            byType: { images: 0, videos: 0, gifs: 0 }
        };
        
        let successfulArtists = 0;
        let failedArtists = 0;
        let skippedArtists = 0;
        let hasUploadData = false;
        
        for (const result of results) {
            if (result.success) {
                if (result.error) {
                    skippedArtists++;
                } else {
                    successfulArtists++;
                }
            } else {
                failedArtists++;
            }
            
            // Aggregate download stats
            downloadStats.total += result.stats.total;
            downloadStats.successful += result.stats.successful;
            downloadStats.failed += result.stats.failed;
            downloadStats.skipped += result.stats.skipped;
            
            // Aggregate upload stats if available
            if (result.uploadResult) {
                hasUploadData = true;
                uploadStats.successful += result.uploadResult.successful;
                uploadStats.failed += result.uploadResult.failed;
                uploadStats.skipped += result.uploadResult.skipped;
                uploadStats.total += result.uploadResult.total;
            }
        }
        
        return {
            totalArtists: results.length,
            successfulArtists,
            failedArtists,
            skippedArtists,
            downloadStats,
            uploadStats: hasUploadData ? uploadStats : undefined
        };
    }
}