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
import { ScraperError, ScraperErrorType } from './interfaces/ScraperTypes';
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
      
      this.logger.info('Starting Twitter/X Image Scraper');
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
          
          // Extract image URLs
          const imageDataList = await twitterScraper.extractImageUrls();
          
          if (imageDataList.length === 0) {
            this.logger.warn(`No images found for @${artist}`);
            continue;
          }
          
          // Download images
          const downloadResult = await twitterScraper.downloadImages(imageDataList);
          
          // Upload to Google Drive if enabled
          if (this.googleDriveUploader && downloadResult.downloadedPaths.length > 0) {
            try {
              this.logger.info(`Starting batch upload of ${downloadResult.downloadedPaths.length} images for @${artist}`);
              const uploadResult = await this.googleDriveUploader.batchUpload(downloadResult.downloadedPaths, artist);
              this.logger.success(`Upload completed for @${artist}: ${uploadResult.successful}/${uploadResult.total} successful, ${uploadResult.failed} failed, ${uploadResult.skipped} skipped`);
            } catch (error) {
              this.logger.error(`Upload failed for @${artist}`, error as Error);
              // Continue processing next artist even if upload fails
            }
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
      this.logger.success(`Scrape-only completed. Downloaded ${stats.successful}/${stats.total} images`);
      
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
   * This mode will scan the download directory for existing images and upload them to Google Drive
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
      
      // Scan existing images in the download directory
      const existingImages = await this.scanExistingImages(scraperConfig.downloadPath);
      
      if (Object.keys(existingImages).length === 0) {
        this.logger.info('No images found in the download directory to upload.');
        return;
      }
      
      this.logger.info(`Found ${Object.keys(existingImages).length} artists with images to upload`);
      
      // Process each artist's folder
      for (const artist of Object.keys(existingImages)) {
        const imagePaths = existingImages[artist];
        
        if (imagePaths.length === 0) {
          this.logger.warn(`No images found for ${artist}, skipping...`);
          continue;
        }
        
        try {
          this.logger.info(`Starting batch upload of ${imagePaths.length} images for @${artist}`);
          const uploadResult = await this.googleDriveUploader.batchUpload(imagePaths, artist);
          this.logger.success(`Upload completed for @${artist}: ${uploadResult.successful}/${uploadResult.total} successful, ${uploadResult.failed} failed, ${uploadResult.skipped} skipped`);
        } catch (error) {
          this.logger.error(`Upload failed for @${artist}`, error as Error);
          // Continue with next artist
        }
      }
      
      this.logger.success('Upload-only mode completed successfully');
      
      // Clean up old files based on retention policy (keep files for 3 days by default)
      try {
        this.logger.info('Starting cleanup of files older than 3 days...');
        await FileCleanup.cleanupOldFiles(scraperConfig.downloadPath, 3);
        this.logger.info('File cleanup completed');
      } catch (error) {
        this.logger.error('File cleanup failed', error as Error);
        // Continue execution - cleanup failure shouldn't halt the process
      }
    } catch (error) {
      this.logger.error('Upload-only execution failed', error as Error);
      throw error;
    }
  }
  
  /**
   * Scan the download directory for existing images
   * @param downloadPath The base download directory path
   * @returns Object mapping artist names to arrays of image file paths
   */
  private async scanExistingImages(downloadPath: string): Promise<Record<string, string[]>> {
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
        
        // Filter for image files
        const imageFiles = files.filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
        });
        
        if (imageFiles.length > 0) {
          // Map to full file paths
          result[artist] = imageFiles.map(file => path.join(artistPath, file));
        }
      }
      
      return result;
    } catch (error) {
      this.logger.error('Error scanning existing images', error as Error);
      return result;
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
    .scriptName('twitter-image-scraper')
    .usage('$0 [options]')
    .option('scrape-only', {
      alias: 's',
      type: 'boolean',
      description: 'Run in scrape-only mode (no Google Drive upload)'
    })
    .option('upload-only', {
      alias: 'u',
      type: 'boolean',
      description: 'Run in upload-only mode (upload existing images without scraping)'
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
    const isScrapeOnly = argv['scrape-only'] || argv.scrapeOnly;
    const isUploadOnly = argv['upload-only'] || argv.uploadOnly;
    
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
