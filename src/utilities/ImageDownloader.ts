/**
 * ImageDownloader: Utility class for downloading and saving images
 * Supports concurrent downloads with rate limiting
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { ImageData, DownloadStats, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import { ProgressLogger } from './ProgressLogger';
import { Semaphore } from './Semaphore';

export class ImageDownloader {
  private baseDir: string;
  private stats: DownloadStats;
  private progressLogger: ProgressLogger;
  private downloadSemaphore: Semaphore;
  // Track currently active downloads for logging purposes
  private activeDownloads = 0;

  /**
   * Constructor
   * @param downloadDir Base directory for downloads
   */
  constructor(downloadDir: string) {
    this.baseDir = downloadDir;
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0
    };
    
    // Initialize progress logger
    this.progressLogger = ProgressLogger.getInstance();
    
    // Create semaphore to limit concurrent downloads (default: 5)
    const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '5', 10);
    this.downloadSemaphore = new Semaphore(maxConcurrent);
    
    // Ensure the download directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Download multiple images concurrently
   * @param imageDataList Array of image data to download
   * @returns Promise resolving to array of downloaded file paths
   */
  public async downloadImages(imageDataList: ImageData[]): Promise<string[]> {
    if (imageDataList.length === 0) {
      return [];
    }
    
    // Use Promise.all with semaphore to download concurrently with limits
    const downloadPromises = imageDataList.map(imageData => 
      this.downloadSemaphore.execute(() => this.downloadImage(imageData))
    );
    
    // Wait for all downloads to complete
    const results = await Promise.allSettled(downloadPromises);
    
    // Extract successful downloads
    return results
      .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
      .map(result => result.value);
  }

  /**
   * Download a single image from a URL
   * @param imageData Image data containing URL, tweet ID, username and index
   * @returns Promise resolving to the path where the image was saved
   */
  public async downloadImage(imageData: ImageData): Promise<string> {
    const { url, tweetId, username, index } = imageData;
    this.stats.total++;
    this.activeDownloads++;
    
    try {
      // Create user-specific directory if it doesn't exist
      const userDir = path.join(this.baseDir, username);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
      
      // Determine the file extension from the URL
      const extensionMatch = url.match(/\.(jpg|jpeg|png|gif|webp)(?:$|\?)/i);
      const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'jpg';
      
      // Create the filename: username_tweetId_index.extension
      const filename = `${username}_${tweetId}_${index}.${extension}`;
      const filepath = path.join(userDir, filename);
      
      // Check if the file already exists
      if (fs.existsSync(filepath)) {
        this.stats.skipped++;
        this.progressLogger.info(`Skipped existing image: ${filename}`);
        return filepath;
      }
      
      // Download the image
      await this.downloadFile(url, filepath);
      this.stats.successful++;
      this.progressLogger.info(`Successfully downloaded image: ${filename} (Active: ${this.activeDownloads})`);
      return filepath;
    } catch (error) {
      this.stats.failed++;
      throw new ScraperError(
        `Failed to download image ${url}: ${(error as Error).message}`,
        ScraperErrorType.DOWNLOAD_ERROR
      );
    } finally {
      this.activeDownloads--;
    }
  }

  /**
   * Download a file from URL to a local path
   * @param url URL of the file to download
   * @param outputPath Local path where to save the file
   * @returns Promise that resolves when download is complete
   */
  private downloadFile(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Add timeout to prevent hanging downloads
      const timeout = setTimeout(() => {
        reject(new Error('Download timed out after 30 seconds'));
      }, 30000);
      
      const file = fs.createWriteStream(outputPath);
      
      const request = https.get(url, response => {
        // Check if the response is valid
        if (response.statusCode !== 200) {
          clearTimeout(timeout);
          reject(new Error(`Failed to download file, status code: ${response.statusCode}`));
          return;
        }
        
        // Get content length for progress calculation if available
        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileName = path.basename(outputPath);
        const startTime = Date.now();
        
        // Pipe the response data to the file
        response.pipe(file);
        
        // Track download progress if content length is available
        if (contentLength > 0) {
          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const progress = Math.floor((downloadedBytes / contentLength) * 100);
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = downloadedBytes / elapsed / 1024; // KB/s
            
            // Only log detailed progress for significant milestones to reduce console noise
            if (progress % 50 === 0 && progress > 0) {
              this.progressLogger.info(`Downloading ${fileName}: ${progress}% at ${speed.toFixed(1)} KB/s`);
            }
          });
        }
        
        // Handle error events
        response.on('error', err => {
          clearTimeout(timeout);
          fs.unlink(outputPath, () => {}); // Delete the file on error
          reject(err);
        });
        
        // Resolve when the file has been fully written
        file.on('finish', () => {
          clearTimeout(timeout);
          file.close();
          resolve();
        });
        
        // Handle file write errors
        file.on('error', err => {
          clearTimeout(timeout);
          fs.unlink(outputPath, () => {}); // Delete the file on error
          reject(err);
        });
      });
      
      // Handle request errors
      request.on('error', err => {
        clearTimeout(timeout);
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(err);
      });
      
      // Set a timeout for the request itself
      request.setTimeout(15000, () => {
        request.abort();
        reject(new Error('Request timed out'));
      });
    });
  }

  /**
   * Get current download statistics
   * @returns Current download stats
   */
  public getStats(): DownloadStats {
    return { ...this.stats };
  }
}
