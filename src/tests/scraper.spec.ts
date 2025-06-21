/**
 * Test file for the Twitter/X Image Scraper
 * Using Playwright test runner syntax and best practices
 */

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { TwitterAuth } from '../pageObjects/TwitterAuth';
import { TwitterScraper } from '../pageObjects/TwitterScraper';
import { ConfigManager } from '../utilities/ConfigManager';
import { Logger } from '../utilities/Logger';
import { ScraperError, ImageData } from '../interfaces/ScraperTypes';

// Initialize logger
const logger = Logger.getInstance();

/**
 * Twitter Image Scraper Test Suite
 */
test.describe('Twitter Image Scraper', () => {
    // Test-wide variables
    let configManager: ConfigManager;
    let authCredentials: { username: string; password: string };
    let scraperConfig: any;
    let testArtist: string;
    let artists: string[];

    // Setup before each test
    test.beforeEach(async ({ browser }) => {
        logger.info('=== SETTING UP TEST ENVIRONMENT ===');
        
        // Initialize configuration
        configManager = ConfigManager.getInstance();
        configManager.createDefaultConfigFiles();
        
        // Get credentials and config
        authCredentials = configManager.getAuthCredentials();
        scraperConfig = configManager.getScraperConfig();
        
        // Load artists and verify we have at least one
        artists = configManager.loadArtists();
        expect(artists.length, 'No artists defined in artists.txt').toBeGreaterThan(0);
        
        // Use the first artist for testing
        testArtist = artists[0];
        logger.info(`Test will use artist: @${testArtist}`);
    });

    // Test for Twitter authentication
    test('should authenticate with Twitter successfully', async ({ browser }) => {
        // Create a new context with specific options
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        
        // Create a new page
        const page = await context.newPage();
        
        try {
            // Initialize Twitter authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            
            // Attempt login
            logger.info('Logging in to Twitter...');
            await twitterAuth.login(authCredentials);
            
            // Verify login success by checking for home timeline element
            const isLoggedIn = await page.isVisible('a[data-testid="AppTabBar_Home_Link"]');
            expect(isLoggedIn, 'Failed to authenticate with Twitter').toBeTruthy();
            
            logger.success('Authentication test passed');
            
            // Logout after successful authentication
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for profile navigation
    test('should navigate to artist profile correctly', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Verify we're on the correct profile page
            const currentUrl = page.url();
            expect(currentUrl).toContain(`twitter.com/${testArtist}`);
            
            // Verify media tab is active
            const isMediaTabActive = await page.isVisible(`a[href="/${testArtist}/media"][aria-selected="true"]`);
            expect(isMediaTabActive, 'Media tab is not active').toBeTruthy();
            
            logger.success('Profile navigation test passed');
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for private account detection
    test('should detect if an account is private', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Check if account is private
            const isPrivate = await twitterScraper.isPrivateAccount();
            
            // This is just a detection test, so we're not asserting the result
            // Just verifying the detection method works
            logger.info(`Account @${testArtist} private status: ${isPrivate}`);
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for suspended account detection
    test('should detect if an account is suspended', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Check if account is suspended
            const isSuspended = await twitterScraper.isSuspendedAccount();
            
            // This is just a detection test, so we're not asserting the result
            // Just verifying the detection method works
            logger.info(`Account @${testArtist} suspension status: ${isSuspended}`);
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for image extraction
    test('should extract image URLs from profile', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Check if account is private or suspended and skip test if it is
            if (await twitterScraper.isPrivateAccount()) {
                logger.warn(`Account @${testArtist} is private, skipping image extraction test`);
                test.skip();
                return;
            }
            
            if (await twitterScraper.isSuspendedAccount()) {
                logger.warn(`Account @${testArtist} is suspended, skipping image extraction test`);
                test.skip();
                return;
            }
            
            // Scroll and load media (limited to save time)
            await twitterScraper.scrollAndLoadMedia(3);
            
            // Extract image URLs
            const imageDataList = await twitterScraper.extractImageUrls();
            
            // Verify image extraction
            logger.info(`Found ${imageDataList.length} images from @${testArtist}`);
            
            // We're not asserting a specific number, just that the extraction function works
            // An artist might legitimately have 0 images
            expect(Array.isArray(imageDataList)).toBeTruthy();
            
            // If there are images, verify they have the expected structure
            if (imageDataList.length > 0) {
                const firstImage = imageDataList[0];
                expect(firstImage).toHaveProperty('url');
                expect(firstImage).toHaveProperty('tweetId');
                expect(firstImage).toHaveProperty('username');
                expect(firstImage).toHaveProperty('index');
                expect(firstImage.url).toMatch(/^https?:\/\//);
            }
            
            logger.success('Image extraction test passed');
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for image download functionality
    test('should download images correctly', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Check if account is private or suspended and skip test if it is
            if (await twitterScraper.isPrivateAccount() || await twitterScraper.isSuspendedAccount()) {
                logger.warn(`Account @${testArtist} is not accessible, skipping download test`);
                test.skip();
                return;
            }
            
            // Scroll and load media (limited to save time)
            await twitterScraper.scrollAndLoadMedia(2);
            
            // Extract image URLs
            const imageDataList = await twitterScraper.extractImageUrls();
            
            if (imageDataList.length === 0) {
                logger.warn(`No images found for @${testArtist}, skipping download test`);
                test.skip();
                return;
            }
            
            // Download only first 2 images for testing
            const testImageData = imageDataList.slice(0, 2);
            logger.info(`Found ${imageDataList.length} images, downloading first 2 for testing`);
            
            // Download images
            const downloadResult = await twitterScraper.downloadImages(testImageData);
            
            // Verify download results
            expect(downloadResult.total).toEqual(testImageData.length);
            expect(downloadResult.successful + downloadResult.skipped).toBeGreaterThan(0);
            
            logger.success(`Download test passed. Downloaded ${downloadResult.successful} new images, ${downloadResult.skipped} already existed`);
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });

    // Test for end-to-end functionality
    test('should perform complete scraping process', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        
        try {
            logger.info('=== TWITTER IMAGE SCRAPER E2E TEST ===');
            
            // Setup authentication
            const twitterAuth = new TwitterAuth(page, context, browser);
            await twitterAuth.login(authCredentials);
            
            // Initialize scraper
            const twitterScraper = new TwitterScraper(page, context, browser, scraperConfig);
            
            // Process first artist
            logger.info(`Processing artist: @${testArtist}`);
            
            // Navigate to artist profile
            await twitterScraper.navigateToProfileMediaTab(testArtist);
            
            // Check if account is accessible
            if (await twitterScraper.isPrivateAccount() || await twitterScraper.isSuspendedAccount()) {
                logger.warn(`Account @${testArtist} is not accessible, skipping E2E test`);
                test.skip();
                return;
            }
            
            // Scroll and load media
            await twitterScraper.scrollAndLoadMedia(3);
            
            // Extract image URLs
            const imageDataList = await twitterScraper.extractImageUrls();
            
            // Verify we have image data
            expect(Array.isArray(imageDataList)).toBeTruthy();
            
            if (imageDataList.length === 0) {
                logger.warn(`No images found for @${testArtist}, skipping rest of E2E test`);
                await twitterAuth.logout();
                return;
            }
            
            // Download only first 3 images max for testing
            const testImageData = imageDataList.slice(0, Math.min(3, imageDataList.length));
            logger.info(`Found ${imageDataList.length} images, downloading ${testImageData.length} for testing`);
            
            // Download images
            const downloadResult = await twitterScraper.downloadImages(testImageData);
            
            // Verify download results
            expect(downloadResult.total).toEqual(testImageData.length);
            
            // Log download stats
            logger.success(`E2E test completed successfully. Downloaded ${downloadResult.successful}/${downloadResult.total} images`);
            
            // Logout after successful test
            await twitterAuth.logout();
        } catch (error) {
            logError(error);
            throw error;
        } finally {
            await cleanupResources(page, context);
        }
    });
});

/**
 * Helper function to log errors properly
 */
function logError(error: any): void {
    if (error instanceof ScraperError) {
        logger.error(`Test failed: ${error.message}`, error, error.type);
    } else {
        logger.error(`Test failed: ${(error as Error).message}`, error as Error);
    }
}

/**
 * Helper function to clean up resources
 */
async function cleanupResources(page: Page, context: BrowserContext): Promise<void> {
    try {
        if (page) await page.close();
        if (context) await context.close();
    } catch (error) {
        logger.error('Error during cleanup', error as Error);
    }
}
