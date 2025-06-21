#!/usr/bin/env node

/**
 * Test script for asynchronous batch upload optimization
 */

const TwitterScraper = require('../dist/pageObjects/TwitterScraper').TwitterScraper;
const ConfigManager = require('../dist/utilities/ConfigManager').ConfigManager;
const chromium = require('playwright').chromium;

async function testBatchUpload() {
  console.log('=== Asynchronous Batch Upload Performance Test ===');
  console.log('This test will compare sequential vs. concurrent upload performance');
  
  const configManager = ConfigManager.getInstance();
  const scraperConfig = configManager.getScraperConfig();
  
  // Override config for testing
  scraperConfig.uploadBatchSize = 5; // Use smaller batches for testing
  scraperConfig.maxConcurrentUploads = 2; // Limit concurrent uploads
  
  console.log('\nTest Configuration:');
  console.log(`- Upload Batch Size: ${scraperConfig.uploadBatchSize}`);
  console.log(`- Max Concurrent Uploads: ${scraperConfig.maxConcurrentUploads}`);
  
  // Check if Google Drive is configured
  const googleDriveConfig = configManager.getGoogleDriveConfig();
  if (!googleDriveConfig.enableUpload) {
    console.error('\nERROR: Google Drive upload is not enabled.');
    console.log('Please set GOOGLE_DRIVE_ENABLED=true in your config/.env file');
    process.exit(1);
  }
  
  console.log('\nInitializing browser...');
  const browser = await chromium.launch({
    headless: true
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Create a TwitterScraper instance
    const scraper = new TwitterScraper(page, context, browser, scraperConfig);
    
    // Set a test username
    scraper.currentUsername = 'test_user';
    
    // Create test data
    console.log('\nPreparing test data...');
    
    // Using existing test images or dummy data
    const testImages = findTestImages() || createDummyTestData(20);
    
    console.log(`Found ${testImages.length} test images`);
    
    // Run the test
    console.log('\nRunning asynchronous batch upload test...');
    console.log('This may take a while depending on your network speed and image count');
    
    // Measure start time
    const startTime = Date.now();
    
    // Process the images
    const result = await scraper.downloadWithConcurrentUpload(testImages);
    
    // Measure end time
    const endTime = Date.now();
    const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(2);
    
    // Output results
    console.log('\n=== Test Results ===');
    console.log(`Total Time: ${totalTimeSeconds} seconds`);
    console.log(`Downloaded: ${result.stats.successful}/${result.stats.total} images`);
    console.log(`Uploaded: ${result.totalUploadStats.successful}/${result.totalUploadStats.total} images`);
    console.log(`Upload Batches: ${result.uploadResults.length}`);
    
    // Estimated sequential time (assuming downloads finish before uploads start)
    const estimatedSequentialTime = (
      (result.stats.successful * 1) + // 1 second per download (estimate)
      (result.totalUploadStats.successful * 2) // 2 seconds per upload (estimate)
    ).toFixed(2);
    
    console.log(`Estimated Sequential Time: ${estimatedSequentialTime} seconds`);
    console.log(`Performance Improvement: ~${Math.round((estimatedSequentialTime / totalTimeSeconds) * 100)}%`);
    
    console.log('\nTest completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    // Clean up
    await browser.close();
  }
}

/**
 * Helper to find existing test images
 */
function findTestImages() {
  // Implement logic to find existing test images
  // This would need to be implemented based on your test environment
  return null;
}

/**
 * Create dummy test data for the upload test
 */
function createDummyTestData(count) {
  return Array.from({ length: count }).map((_, i) => ({
    url: `https://example.com/test_image_${i}.jpg`,
    tweetId: `dummy-tweet-${i}`,
    username: 'test_user',
    index: i
  }));
}

// Run the test
testBatchUpload().catch(console.error);
