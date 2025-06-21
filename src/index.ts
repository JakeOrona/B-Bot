/**
 * Main entry point for the Twitter/X Image Scraper
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { TwitterAuth } from './pageObjects/TwitterAuth';
import { TwitterScraper } from './pageObjects/TwitterScraper';
import { ConfigManager } from './utilities/ConfigManager';
import { Logger } from './utilities/Logger';
import { ScraperError, ScraperErrorType } from './interfaces/ScraperTypes';
import path from 'path';

/**
 * Main class for the scraper application
 */
class TwitterImageScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private configManager: ConfigManager;
  private logger: Logger;
  
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
      
      this.logger.info('Browser initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize scraper', error as Error);
      throw error;
    }
  }
  
  /**
   * Run the scraper process
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
          await twitterScraper.downloadImages(imageDataList);
          
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
      await twitterScraper.cleanupOldFiles(3);
      
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
 * Entry point for the application
 */
async function main(): Promise<void> {
  const scraper = new TwitterImageScraper();
  
  try {
    await scraper.initialize();
    await scraper.run();
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
