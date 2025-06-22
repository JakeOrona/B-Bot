/**
 * Main entry point for the Twitter/X Image Scraper
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { TwitterAuth } from './pageObjects/TwitterAuth';
import { TwitterScraper } from './pageObjects/TwitterScraper';
import { ConfigManager } from './utilities/ConfigManager';
import { Logger } from './utilities/Logger';
import { ProgressLogger } from './utilities/ProgressLogger';
import { GoogleDriveUploader } from './utilities/GoogleDriveUploader';
import { FileCleanup } from './utilities/FileCleanup';
import { ScraperError, ScraperErrorType } from './interfaces/ScraperTypes';
import path from 'path';
import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import colors from 'colors';

/**
 * Main class for the scraper application
 */
class TwitterImageScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private configManager: ConfigManager;
  private logger: Logger;
  private progressLogger!: ProgressLogger;  // Initialized in initialize method
  private googleDriveUploader: GoogleDriveUploader | null = null;
  
  /**
   * Constructor
   */
  constructor() {
    this.configManager = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
    // We'll initialize the progressLogger in the initialize method
    // after loading the configuration
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
      
      // Initialize progress logger
      const progressConfig = this.configManager.getProgressConfig();
      this.progressLogger = ProgressLogger.getInstance(progressConfig);
      
      // Add Google Drive configuration if enabled
      const googleDriveConfig = this.configManager.getGoogleDriveConfig();
      if (googleDriveConfig.enableUpload) {
        config.googleDrive = googleDriveConfig;
        this.progressLogger.info('Google Drive integration enabled');
      }
      
      // Show initialization message based on log mode
      if (progressConfig.logMode === 'concise') {
        console.log(colors.cyan('Twitter Image Scraper Started\n'));
      } else {
        this.progressLogger.info('Starting Twitter/X Image Scraper');
      }
      
      this.progressLogger.info(`Headless mode: ${config.headless ? 'enabled' : 'disabled'}`);
      
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
          this.progressLogger.info('Google Drive uploader initialized');
        } catch (error) {
          this.progressLogger.error('Failed to initialize Google Drive uploader', error as Error);
          // Continue without Google Drive upload capability
        }
      }
      
      this.progressLogger.info('Browser initialized successfully');
    } catch (error) {
      this.progressLogger.error('Failed to initialize scraper', error as Error);
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
      const concurrentConfig = this.configManager.getConcurrentConfig();
      
      // Initialize authentication
      const twitterAuth = new TwitterAuth(this.page, this.context, this.browser);
      
      // Login to Twitter
      this.logger.info('Logging in to Twitter...');
      await twitterAuth.login(authCredentials);
      
      // Get list of artists to scrape
      const artists = this.configManager.loadArtists();
      this.logger.info(`Found ${artists.length} artists to scrape`);
      
      // Check if concurrent processing should be used
      if (concurrentConfig.enabled && artists.length > 1) {
        this.logger.info(`Using concurrent processing with ${concurrentConfig.maxConcurrentProfiles} workers`);
        
        // Import the ConcurrentProfileManager
        const { ConcurrentProfileManager } = await import('./utilities/ConcurrentProfileManager');
        
        // Initialize concurrent profile manager
        const concurrentManager = new ConcurrentProfileManager(
          this.browser,
          this.context,
          this.page,
          scraperConfig,
          concurrentConfig
        );
        
        // Start concurrent processing of all artists
        await concurrentManager.startProcessing(artists);
        
        // Get combined statistics
        const stats = concurrentManager.getProcessingStats();
        this.logger.success(
          `Concurrent processing completed: Processed ${stats.completedProfiles}/${stats.totalProfiles} artists, ` +
          `Downloaded ${stats.totalImagesDownloaded}/${stats.totalImages} images`
        );
      } else {
        // Initialize scraper for sequential processing
        const twitterScraper = new TwitterScraper(
          this.page,
          this.context,
          this.browser,
          scraperConfig
        );
        
        this.logger.info(`Using sequential processing for ${artists.length} artists`);
        
        // Process each artist sequentially
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
            
            // Extract image URLs
            const imageDataList = await twitterScraper.extractImageUrls();
            
            if (imageDataList.length === 0) {
              this.logger.warn(`No images found for @${artist}`);
              continue;
            }
            
            // Download images with concurrent uploads
            const downloadResult = await twitterScraper.downloadImages(imageDataList);
            
            // If we're using the old upload flow (not concurrent)
            if (this.googleDriveUploader && downloadResult.downloadedPaths.length > 0 && !downloadResult.totalUploadStats) {
              try {
                this.logger.info(`Starting batch upload of ${downloadResult.downloadedPaths.length} images for @${artist}`);
                const uploadResult = await this.googleDriveUploader.batchUpload(downloadResult.downloadedPaths, artist);
                this.logger.success(`Upload completed for @${artist}: ${uploadResult.successful}/${uploadResult.total} successful, ${uploadResult.failed} failed, ${uploadResult.skipped} skipped`);
              } catch (error) {
                this.logger.error(`Upload failed for @${artist}`, error as Error);
                // Continue processing next artist even if upload fails
              }
            } else if (downloadResult.totalUploadStats) {
              // Concurrent uploads completed, just log the final stats
              this.logger.success(
                `Processing completed for @${artist}: Downloaded ${downloadResult.stats.successful}/${downloadResult.stats.total} images, ` +
                `Uploaded ${downloadResult.totalUploadStats.successful}/${downloadResult.totalUploadStats.total} images to Google Drive`
              );
            }
            
            // Add a delay between processing artists
            await new Promise(resolve => setTimeout(resolve, scraperConfig.rateLimitDelay));
          } catch (error) {
            if (error instanceof ScraperError) {
              this.logger.error(`Error processing artist @${artist}`, error, error.type);
            } else {
              this.logger.error(`Error processing artist @${artist}`, error as Error);
            }
            // Continue with next artist
            continue;
          }
        }
        
        // Log download stats
        const stats = twitterScraper.getDownloadStats();
        this.logger.success(`Scraping completed. Downloaded ${stats.successful}/${stats.total} images`);
      }
      
      // Clean up old files based on retention policy (keep files for 3 days by default)
      try {
        this.logger.info('Starting cleanup of files older than 3 days...');
        await FileCleanup.cleanupOldFiles(scraperConfig.downloadPath, 3);
        this.logger.info('File cleanup completed');
      } catch (error) {
        this.logger.error('File cleanup failed', error as Error);
        // Continue execution - cleanup failure shouldn't halt the process
      }
      
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
      const concurrentConfig = this.configManager.getConcurrentConfig();
      
      // Initialize authentication
      const twitterAuth = new TwitterAuth(this.page, this.context, this.browser);
      
      // Login to Twitter
      this.logger.info('Logging in to Twitter...');
      await twitterAuth.login(authCredentials);
      
      // Get list of artists to scrape
      const artists = this.configManager.loadArtists();
      this.logger.info(`Found ${artists.length} artists to scrape in scrape-only mode`);
      
      // Check if concurrent processing should be used
      if (concurrentConfig.enabled && artists.length > 1) {
        this.logger.info(`Using concurrent processing with ${concurrentConfig.maxConcurrentProfiles} workers for scrape-only mode`);
        
        // Override Google Drive settings
        scraperConfig.googleDrive = { enableUpload: false, credentialsPath: '', rootFolderId: '' };
        
        // Import the ConcurrentProfileManager
        const { ConcurrentProfileManager } = await import('./utilities/ConcurrentProfileManager');
        
        // Initialize concurrent profile manager
        const concurrentManager = new ConcurrentProfileManager(
          this.browser,
          this.context,
          this.page,
          scraperConfig,
          concurrentConfig
        );
        
        // Start concurrent processing of all artists
        await concurrentManager.startProcessing(artists);
        
        // Get combined statistics
        const stats = concurrentManager.getProcessingStats();
        this.logger.success(
          `Concurrent processing completed: Processed ${stats.completedProfiles}/${stats.totalProfiles} artists, ` +
          `Downloaded ${stats.totalImagesDownloaded}/${stats.totalImages} images`
        );
      } else {
        // Initialize scraper
        const twitterScraper = new TwitterScraper(
          this.page,
          this.context,
          this.browser,
          scraperConfig
        );
        
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
            
            // Extract image URLs
            const imageDataList = await twitterScraper.extractImageUrls();
            
            if (imageDataList.length === 0) {
              this.logger.warn(`No images found for @${artist}`);
              continue;
            }
            
            // Download images without uploading
            const downloadResult = await twitterScraper.downloadImages(imageDataList);
            this.logger.info(`Downloaded ${downloadResult.downloadedPaths.length} images for @${artist}`);
            
            // Add a delay between processing artists
            await new Promise(resolve => setTimeout(resolve, scraperConfig.rateLimitDelay));
          } catch (error) {
            if (error instanceof ScraperError) {
              this.logger.error(`Error processing artist @${artist}`, error, error.type);
            } else {
              this.logger.error(`Error processing artist @${artist}`, error as Error);
            }
            // Continue with next artist
            continue;
          }
        }
        
        // Log download stats
        const stats = twitterScraper.getDownloadStats();
        this.logger.success(`Scraping completed. Downloaded ${stats.successful}/${stats.total} images`);
      }
      
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
   * Run upload-only mode (upload existing files without scraping)
   */
  public async runUploadOnly(): Promise<void> {
    try {
      const scraperConfig = this.configManager.getScraperConfig();
      const googleDriveConfig = this.configManager.getGoogleDriveConfig();
      
      if (!googleDriveConfig.enableUpload || !googleDriveConfig.rootFolderId) {
        throw new ScraperError(
          'Google Drive upload is not enabled or properly configured',
          ScraperErrorType.CONFIG_ERROR
        );
      }
      
      this.logger.info('Starting upload-only mode');
      
      // Initialize Google Drive uploader if not already initialized
      if (!this.googleDriveUploader) {
        this.googleDriveUploader = new GoogleDriveUploader(
          googleDriveConfig.credentialsPath,
          googleDriveConfig.rootFolderId
        );
      }
      
      // Get artists list for folder organization
      const artists = this.configManager.loadArtists();
      
      // Process each artist's folder
      for (const artist of artists) {
        const artistPath = path.join(scraperConfig.downloadPath, artist);
        
        // Check if folder exists
        if (!fs.existsSync(artistPath)) {
          this.logger.warn(`No download folder found for ${artist}, skipping`);
          continue;
        }
        
        // Get list of files in the folder
        const files = fs.readdirSync(artistPath)
          .filter(file => file.endsWith('.jpg') || file.endsWith('.png'))
          .map(file => path.join(artistPath, file));
        
        if (files.length === 0) {
          this.logger.warn(`No images found for ${artist}, skipping`);
          continue;
        }
        
        this.logger.info(`Found ${files.length} images for ${artist}, starting upload`);
        
        try {
          // Upload files
          const result = await this.googleDriveUploader.batchUpload(files, artist);
          this.logger.success(`Upload completed for ${artist}: ${result.successful}/${result.total} successful, ${result.failed} failed, ${result.skipped} skipped`);
        } catch (error) {
          this.logger.error(`Upload failed for ${artist}`, error as Error);
          // Continue with next artist
        }
      }
      
      this.logger.success('Upload-only mode completed');
    } catch (error) {
      this.logger.error('Upload-only mode failed', error as Error);
      throw error;
    }
  }
  
  /**
   * Clean up resources
   */
  private async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      
      if (this.googleDriveUploader) {
        this.googleDriveUploader = null;
      }
      
      this.logger.info('Resources cleaned up');
    } catch (error) {
      this.logger.error('Error during cleanup', error as Error);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  // Parse command line arguments
  const argv = await yargs(hideBin(process.argv))
    .option('mode', {
      alias: 'm',
      describe: 'Mode of operation',
      type: 'string',
      choices: ['full', 'scrape-only', 'upload-only'],
      default: 'full'
    })
    .help()
    .alias('help', 'h')
    .version(false)
    .parseAsync();

  const scraper = new TwitterImageScraper();

  try {
    await scraper.initialize();
    
    switch (argv.mode) {
      case 'scrape-only':
        await scraper.runScrapeOnly();
        break;
      case 'upload-only':
        await scraper.runUploadOnly();
        break;
      default:
        await scraper.run();
    }
    
    console.log(colors.green('\nTwitter Image Scraper completed successfully!'));
    process.exit(0);
  } catch (error) {
    console.error(colors.red(`\nTwitter Image Scraper failed: ${(error as Error).message}`));
    process.exit(1);
  }
}

// Run the application
if (require.main === module) {
  main().catch(error => {
    console.error(colors.red(`Fatal error: ${error.message}`));
    process.exit(1);
  });
}
