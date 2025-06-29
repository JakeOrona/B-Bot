/**
 * Main entry point for the Twitter/X Image Scraper
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { TwitterAuth } from './pageObjects/TwitterAuth';
import { TwitterScraper } from './pageObjects/TwitterScraper';
import { ConfigManager } from './utilities/ConfigManager';
import { Logger } from './utilities/Logger';
import { GoogleDriveUploader } from './utilities/GoogleDriveUploader';
import { FileCleanup } from './utilities/FileCleanup';
import { ScraperError, ScraperErrorType, MediaData } from './interfaces/ScraperTypes';
import path from 'path';
import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Main class for the scraper application
 */
class TwitterImageScraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private configManager: ConfigManager;
    private logger: Logger;
    private googleDriveUploader: GoogleDriveUploader | null = null;
    
    /**
     * Constructor
     */
    constructor() {
        this.configManager = ConfigManager.getInstance();
        this.logger = Logger.getInstance();
    }
    
    /**
     * Initialize the scraper
     */
    public async initialize(): Promise<void> {
        try {
        // Create default config files if they don't exist
        this.configManager.createDefaultConfigFiles();
        
        // Get scraper configuration
        const config = this.configManager.getScraperConfig();
        
        // Add Google Drive configuration if enabled
        const googleDriveConfig = this.configManager.getGoogleDriveConfig();
        if (googleDriveConfig.enableUpload) {
            config.googleDrive = googleDriveConfig;
            this.logger.info('Google Drive integration enabled');
        }
        
        this.logger.info('Starting Twitter/X Media Scraper');
        this.logger.info(`Headless mode: ${config.headless ? 'enabled' : 'disabled'}`);
        
        // Launch browser
        this.browser = await chromium.launch({
            headless: config.headless
        });
        
        // Create browser context with specific options
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            timezoneId: 'America/New_York',
        });
        
        // Create new page
        this.page = await this.context.newPage();
        
        // Initialize Google Drive uploader if enabled
        if (googleDriveConfig.enableUpload && googleDriveConfig.rootFolderId) {
            try {
            this.googleDriveUploader = new GoogleDriveUploader(
                googleDriveConfig.credentialsPath,
                googleDriveConfig.rootFolderId
            );
            this.logger.info('Google Drive uploader initialized');
            } catch (error) {
            this.logger.error('Failed to initialize Google Drive uploader', error as Error);
            // Continue without Google Drive upload capability
            }
        }
        
        this.logger.info('Browser initialized successfully');
        } catch (error) {
        this.logger.error('Failed to initialize scraper', error as Error);
        throw error;
        }
    }
    
    /**
     * Run the full scraper process (scrape + upload)
     */
    public async run(): Promise<void> {
        if (!this.browser || !this.context || !this.page) {
        throw new Error('Scraper not initialized. Call initialize() first.');
        }
        
        try {
        const authCredentials = this.configManager.getAuthCredentials();
        const scraperConfig = this.configManager.getScraperConfig();
        
        // Initialize authentication
        const twitterAuth = new TwitterAuth(this.page, this.context, this.browser);
        
        // Login to Twitter
        this.logger.info('Logging in to Twitter...');
        await twitterAuth.login(authCredentials);
        
        // Initialize scraper
        const twitterScraper = new TwitterScraper(
            this.page,
            this.context,
            this.browser,
            scraperConfig
        );
        
        // Get list of artists to scrape
        const artists = this.configManager.loadArtists();
        this.logger.info(`Found ${artists.length} artists to scrape`);
        
        // Process each artist
        for (const artist of artists) {
            try {
            this.logger.info(`Processing artist: @${artist}`);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(artist);
            
            // Check if account is private or suspended
            if (await twitterScraper.isPrivateAccount()) {
                this.logger.warn(`Skipping private account: @${artist}`);
                continue;
            }
            
            if (await twitterScraper.isSuspendedAccount()) {
                this.logger.warn(`Skipping suspended account: @${artist}`);
                continue;
            }
            
            // Scroll and load media
            await twitterScraper.scrollAndLoadMedia();
            
            // Extract media URLs (images, videos, GIFs)
            const mediaDataList = await twitterScraper.extractMediaUrls();
            
            if (mediaDataList.length === 0) {
                this.logger.warn(`No media found for @${artist}`);
                continue;
            }
            
            this.logger.info(`Found ${mediaDataList.length} media items for @${artist}`);
            
            // Download media
            const downloadResult = await twitterScraper.downloadMedia(mediaDataList);
            
            // Log download results with media type breakdown
            this.logger.info(
                `Download completed for @${artist}: ${downloadResult.stats.successful}/${downloadResult.stats.total} successful ` +
                `(${downloadResult.stats.byType.images} images, ${downloadResult.stats.byType.videos} videos, ${downloadResult.stats.byType.gifs} GIFs)`
            );
            
            // Upload to Google Drive if enabled
            await this.handleGoogleDriveUpload(downloadResult.downloadedPaths, artist);
            
            // Add a delay between processing artists
            await new Promise(resolve => setTimeout(resolve, scraperConfig.rateLimitDelay));
            } catch (error) {
            this.handleArtistError(artist, error);
            continue;
            }
        }
        
        // Log final statistics
        await this.logFinalStats(twitterScraper);
        
        // Clean up old files
        await this.performFileCleanup();
        
        // Logout
        await twitterAuth.logout();
        } catch (error) {
        this.logger.error('Scraper execution failed', error as Error);
        throw error;
        } finally {
        await this.cleanup();
        }
    }
    
    /**
     * Run scrape-only mode (without uploading to Google Drive)
     */
    public async runScrapeOnly(): Promise<void> {
        if (!this.browser || !this.context || !this.page) {
        throw new Error('Scraper not initialized. Call initialize() first.');
        }
        
        try {
        const authCredentials = this.configManager.getAuthCredentials();
        const scraperConfig = this.configManager.getScraperConfig();
        
        // Initialize authentication
        const twitterAuth = new TwitterAuth(this.page, this.context, this.browser);
        
        // Login to Twitter
        this.logger.info('Logging in to Twitter...');
        await twitterAuth.login(authCredentials);
        
        // Initialize scraper
        const twitterScraper = new TwitterScraper(
            this.page,
            this.context,
            this.browser,
            scraperConfig
        );
        
        // Get list of artists to scrape
        const artists = this.configManager.loadArtists();
        this.logger.info(`Found ${artists.length} artists to scrape in scrape-only mode`);
        
        // Process each artist
        for (const artist of artists) {
            try {
            this.logger.info(`Processing artist: @${artist}`);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(artist);
            
            // Check if account is private or suspended
            if (await twitterScraper.isPrivateAccount()) {
                this.logger.warn(`Skipping private account: @${artist}`);
                continue;
            }
            
            if (await twitterScraper.isSuspendedAccount()) {
                this.logger.warn(`Skipping suspended account: @${artist}`);
                continue;
            }
            
            // Scroll and load media
            await twitterScraper.scrollAndLoadMedia();
            
            // Extract media URLs (images, videos, GIFs)
            const mediaDataList = await twitterScraper.extractMediaUrls();
            
            if (mediaDataList.length === 0) {
                this.logger.warn(`No media found for @${artist}`);
                continue;
            }
            
            // Download media without uploading
            const downloadResult = await twitterScraper.downloadMedia(mediaDataList);
            this.logger.info(
                `Downloaded ${downloadResult.downloadedPaths.length} media items for @${artist} ` +
                `(${downloadResult.stats.byType.images} images, ${downloadResult.stats.byType.videos} videos, ${downloadResult.stats.byType.gifs} GIFs)`
            );
            
            // Add a delay between processing artists
            await new Promise(resolve => setTimeout(resolve, scraperConfig.rateLimitDelay));
            } catch (error) {
            this.handleArtistError(artist, error);
            continue;
            }
        }
        
        // Log final statistics
        await this.logFinalStats(twitterScraper);
        
        // Logout
        await twitterAuth.logout();
        } catch (error) {
        this.logger.error('Scrape-only execution failed', error as Error);
        throw error;
        } finally {
        await this.cleanup();
        }
    }
    
    /**
     * Run upload-only mode (without scraping Twitter)
     * This mode will scan the download directory for existing media and upload them to Google Drive
     */
    public async runUploadOnly(): Promise<void> {
        try {
        const scraperConfig = this.configManager.getScraperConfig();
        
        // Ensure Google Drive uploader is initialized
        if (!this.googleDriveUploader) {
            const googleDriveConfig = this.configManager.getGoogleDriveConfig();
            if (!googleDriveConfig.enableUpload) {
            throw new Error('Google Drive upload is not enabled in configuration');
            }
            
            try {
            this.googleDriveUploader = new GoogleDriveUploader(
                googleDriveConfig.credentialsPath,
                googleDriveConfig.rootFolderId
            );
            this.logger.info('Google Drive uploader initialized');
            } catch (error) {
            throw new Error(`Failed to initialize Google Drive uploader: ${(error as Error).message}`);
            }
        }
        
        this.logger.info('Starting upload-only mode');
        
        // Scan existing media in the download directory
        const existingMedia = await this.scanExistingMedia(scraperConfig.downloadPath);
        
        if (Object.keys(existingMedia).length === 0) {
            this.logger.info('No media found in the download directory to upload.');
            return;
        }
        
        this.logger.info(`Found ${Object.keys(existingMedia).length} artists with media to upload`);
        
        // Process each artist's folder
        for (const artist of Object.keys(existingMedia)) {
            const mediaPaths = existingMedia[artist];
            
            if (mediaPaths.length === 0) {
            this.logger.warn(`No media found for ${artist}, skipping...`);
            continue;
            }
            
            await this.handleGoogleDriveUpload(mediaPaths, artist);
        }
        
        this.logger.success('Upload-only mode completed successfully');
        
        // Clean up old files
        await this.performFileCleanup();
        } catch (error) {
        this.logger.error('Upload-only execution failed', error as Error);
        throw error;
        }
    }
    
    /**
     * Handle Google Drive upload with enhanced logging
     * @param mediaPaths Array of local media file paths
     * @param artist Artist username
     */
    private async handleGoogleDriveUpload(mediaPaths: string[], artist: string): Promise<void> {
        if (!this.googleDriveUploader || mediaPaths.length === 0) {
        return;
        }
        
        try {
        this.logger.info(`Starting batch upload of ${mediaPaths.length} media items for @${artist}`);
        const uploadResult = await this.googleDriveUploader.batchUpload(mediaPaths, artist);
        
        // Log upload results
        this.logger.success(
            `Upload completed for @${artist}: ${uploadResult.successful}/${uploadResult.total} successful, ` +
            `${uploadResult.failed} failed, ${uploadResult.skipped} skipped`
        );
        
        // Log Google Drive storage information
        if (uploadResult.storageInfo) {
            const storage = uploadResult.storageInfo;
            this.logger.info(
            `Google Drive Storage: ${storage.formattedUsed} used / ${storage.formattedTotal} total ` +
            `(${storage.usedPercentage.toFixed(1)}% full, ${storage.formattedAvailable} available)`
            );
            
            // Warn if storage is getting full
            if (storage.usedPercentage > 90) {
            this.logger.warn('Google Drive storage is over 90% full!');
            } else if (storage.usedPercentage > 80) {
            this.logger.warn('Google Drive storage is over 80% full');
            }
        }
        } catch (error) {
        this.logger.error(`Upload failed for @${artist}`, error as Error);
        // Continue processing - upload failure shouldn't halt the process
        }
    }
    
    /**
     * Handle errors when processing an artist
     * @param artist Artist username
     * @param error Error that occurred
     */
    private handleArtistError(artist: string, error: unknown): void {
        if (error instanceof ScraperError) {
        this.logger.error(`Error processing artist @${artist}`, error, error.type);
        } else {
        this.logger.error(`Error processing artist @${artist}`, error as Error);
        }
    }
    
    /**
     * Log final scraping statistics
     * @param twitterScraper TwitterScraper instance
     */
    private async logFinalStats(twitterScraper: TwitterScraper): Promise<void> {
        const stats = twitterScraper.getDownloadStats();
        this.logger.success(
        `Scraping completed. Downloaded ${stats.successful}/${stats.total} media items ` +
        `(${stats.byType.images} images, ${stats.byType.videos} videos, ${stats.byType.gifs} GIFs)`
        );
    }
    
    /**
     * Perform file cleanup based on retention policy
     */
    private async performFileCleanup(): Promise<void> {
        try {
        const scraperConfig = this.configManager.getScraperConfig();
        this.logger.info('Starting cleanup of files older than 3 days...');
        await FileCleanup.cleanupOldFiles(scraperConfig.downloadPath, 3);
        this.logger.info('File cleanup completed');
        } catch (error) {
        this.logger.error('File cleanup failed', error as Error);
        // Continue execution - cleanup failure shouldn't halt the process
        }
    }
    
    /**
     * Scan the download directory for existing media files
     * @param downloadPath The base download directory path
     * @returns Object mapping artist names to arrays of media file paths
     */
    private async scanExistingMedia(downloadPath: string): Promise<Record<string, string[]>> {
        const result: Record<string, string[]> = {};
        
        try {
        // Ensure the download directory exists
        if (!fs.existsSync(downloadPath)) {
            this.logger.warn(`Download directory not found: ${downloadPath}`);
            return result;
        }
        
        // Read the directory contents
        const items = fs.readdirSync(downloadPath);
        
        // Filter for directories (each directory is an artist)
        const artistDirs = items.filter(item => {
            const itemPath = path.join(downloadPath, item);
            return fs.statSync(itemPath).isDirectory();
        });
        
        if (artistDirs.length === 0) {
            this.logger.warn('No artist directories found in the download path');
            return result;
        }
        
        // Process each artist directory
        for (const artist of artistDirs) {
            const artistPath = path.join(downloadPath, artist);
            const files = fs.readdirSync(artistPath);
            
            // Filter for media files (images, videos, GIFs)
            const mediaFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext);
            });
            
            if (mediaFiles.length > 0) {
            // Map to full file paths
            result[artist] = mediaFiles.map(file => path.join(artistPath, file));
            this.logger.info(`Found ${mediaFiles.length} media files for @${artist}`);
            }
        }
        
        return result;
        } catch (error) {
        this.logger.error('Error scanning existing media', error as Error);
        return result;
        }
    }
    
    /**
     * Debug Google Drive configuration and permissions
     * Runs diagnostics on the Google Drive setup
     */
    public async debugGoogleDrive(): Promise<void> {
        this.logger.info('=== Google Drive Debug Mode ===');
        
        try {
        // Get Google Drive configuration
        const googleDriveConfig = this.configManager.getGoogleDriveConfig();
        
        // Check if Google Drive is enabled
        if (!googleDriveConfig.enableUpload) {
            this.logger.error('Google Drive upload is not enabled in configuration');
            this.logger.info('Set GOOGLE_DRIVE_ENABLED=true in your config/.env file');
            return;
        }
        
        this.logger.info('Google Drive Configuration:');
        this.logger.info(`- Upload Enabled: ${googleDriveConfig.enableUpload}`);
        this.logger.info(`- Credentials Path: ${googleDriveConfig.credentialsPath}`);
        this.logger.info(`- Root Folder ID: ${googleDriveConfig.rootFolderId}`);
        
        // Check if credentials file exists
        if (!fs.existsSync(googleDriveConfig.credentialsPath)) {
            this.logger.error(`Google Drive credentials file not found at: ${googleDriveConfig.credentialsPath}`);
            this.logger.info('Make sure you have placed your Service Account JSON file at this location');
            return;
        }
        
        // Check root folder ID
        if (!googleDriveConfig.rootFolderId) {
            this.logger.error('Google Drive root folder ID is empty');
            this.logger.info('Set GOOGLE_DRIVE_ROOT_FOLDER_ID in your config/.env file');
            return;
        }
        
        // Validate folder ID format
        const folderIdPattern = /^[a-zA-Z0-9_-]+$/;
        if (!folderIdPattern.test(googleDriveConfig.rootFolderId)) {
            this.logger.warn(`Root folder ID may be invalid: ${googleDriveConfig.rootFolderId}`);
            this.logger.info('Folder ID should be a string of letters and numbers without slashes or special characters');
        }
        
        this.logger.info('Initializing Google Drive uploader for testing...');
        
        // Initialize the Google Drive uploader
        try {
            this.googleDriveUploader = new GoogleDriveUploader(
            googleDriveConfig.credentialsPath,
            googleDriveConfig.rootFolderId
            );
            
            // Run the debug access tests
            await this.googleDriveUploader.debugFolderAccess();
        } catch (error) {
            this.logger.error('Google Drive initialization failed', error as Error);
            
            // Provide helpful advice
            this.logger.info('\nTroubleshooting Steps:');
            this.logger.info('1. Check that your credentials file contains valid JSON');
            this.logger.info('2. Verify your folder ID is correct (copy from Google Drive URL)');
            this.logger.info('3. Ensure the service account email has been added to the folder with Editor permission');
            this.logger.info('4. Verify the Google Drive API is enabled in your Google Cloud project');
        }
        } catch (error) {
        this.logger.error('Failed to debug Google Drive', error as Error);
        }
    }
    
    /**
     * Clean up resources
     */
    public async cleanup(): Promise<void> {
        this.logger.info('Cleaning up resources...');
        
        if (this.page) {
        await this.page.close();
        }
        
        if (this.context) {
        await this.context.close();
        }
        
        if (this.browser) {
        await this.browser.close();
        }
        
        this.logger.info('Cleanup completed');
    }
    }

    /**
     * Define CLI argument types
     */
    interface CliArgs {
    'scrape-only'?: boolean;
    scrapeOnly?: boolean;
    's'?: boolean;
    'upload-only'?: boolean;
    uploadOnly?: boolean;
    'u'?: boolean;
    'debug-drive'?: boolean;
    debugDrive?: boolean;
    'd'?: boolean;
    'help'?: boolean;
    'h'?: boolean;
    'version'?: boolean;
    'v'?: boolean;
    [key: string]: unknown;
    }

    /**
     * Entry point for the application
     */
    async function main(): Promise<void> {
    // Parse command line arguments
    const argv = yargs(hideBin(process.argv))
        .scriptName('twitter-media-scraper')
        .usage('$0 [options]')
        .option('scrape-only', {
        alias: 's',
        type: 'boolean',
        description: 'Run in scrape-only mode (no Google Drive upload)'
        })
        .option('upload-only', {
        alias: 'u',
        type: 'boolean',
        description: 'Run in upload-only mode (upload existing media without scraping)'
        })
        .option('debug-drive', {
        alias: 'd',
        type: 'boolean',
        description: 'Test Google Drive configuration and permissions'
        })
        .help()
        .alias('help', 'h')
        .version()
        .alias('version', 'v')
        .strict()
        .parseSync() as CliArgs;
        
    // If help or version was requested, exit early (yargs will have printed the info)
    if (argv.help || argv.h || argv.version || argv.v) {
        process.exit(0);
    }

    const scraper = new TwitterImageScraper();
    
    try {
        const isScrapeOnly = argv['scrape-only'] || argv.scrapeOnly || argv.s;
        const isUploadOnly = argv['upload-only'] || argv.uploadOnly || argv.u;
        const isDebugDrive = argv['debug-drive'] || argv.debugDrive || argv.d;
        
        // Debug mode takes precedence
        if (isDebugDrive) {
        console.log('Running in Google Drive debug mode...');
        await scraper.debugGoogleDrive();
        process.exit(0);
        return;
        }
        
        // Check for conflicting flags
        if (isScrapeOnly && isUploadOnly) {
        console.error('Error: Cannot use both --scrape-only and --upload-only flags together');
        process.exit(1);
        }
        
        // Initialize scraper (not needed for upload-only mode)
        if (!isUploadOnly) {
        await scraper.initialize();
        }
        
        // Determine which mode to run
        if (isScrapeOnly) {
        console.log('Running in scrape-only mode...');
        await scraper.runScrapeOnly();
        } else if (isUploadOnly) {
        console.log('Running in upload-only mode...');
        await scraper.runUploadOnly();
        } else {
        console.log('Running in full mode (scrape + upload)...');
        await scraper.run();
        }
        
        process.exit(0);
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the main function if this file is being executed directly
if (require.main === module) {
    main();
}

export { TwitterImageScraper };