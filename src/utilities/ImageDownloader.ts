/**
 * ImageDownloader: Utility class for downloading and saving images
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { ImageData, DownloadStats, ScraperError, ScraperErrorType, VideoData } from '../interfaces/ScraperTypes';

export class ImageDownloader {
  private baseDir: string;
  private stats: DownloadStats;

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
    
    // Ensure the download directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Download an image from a URL
   * @param imageData Image data containing URL, tweet ID, username and index
   * @returns Promise resolving to the path where the image was saved
   */
  public async downloadImage(imageData: ImageData): Promise<string> {
    const { url, tweetId, username, index } = imageData;
    this.stats.total++;
    
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
      console.log(`Skipped existing image: ${filename}`);
      return filepath;
    }
    
    try {
      // Download the image
      await this.downloadFile(url, filepath);
      this.stats.successful++;
      console.log(`Successfully downloaded image: ${filename}`);
      return filepath;
    } catch (error) {
      this.stats.failed++;
      throw new ScraperError(
        `Failed to download image ${url}: ${(error as Error).message}`,
        ScraperErrorType.DOWNLOAD_ERROR
      );
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
      const file = fs.createWriteStream(outputPath);
      
      https.get(url, response => {
        // Check if the response is valid
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download file, status code: ${response.statusCode}`));
          return;
        }
        
        // Pipe the response data to the file
        response.pipe(file);
        
        // Handle error events
        response.on('error', err => {
          fs.unlink(outputPath, () => {}); // Delete the file on error
          reject(err);
        });
        
        // Resolve when the file has been fully written
        file.on('finish', () => {
          file.close();
          resolve();
        });
        
        // Handle file write errors
        file.on('error', err => {
          fs.unlink(outputPath, () => {}); // Delete the file on error
          reject(err);
        });
      }).on('error', err => {
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(err);
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

  /**
   * Download a video from a URL
   * @param videoData Video data containing URL, tweet ID, username and index
   * @returns Promise resolving to the path where the video was saved
   */
  public async downloadVideo(videoData: VideoData): Promise<string> {
      const { url, tweetId, username, index, type } = videoData;
      this.stats.total++;
      
      // Create user-specific directory if it doesn't exist
      const userDir = path.join(this.baseDir, username);
      if (!fs.existsSync(userDir)) {
          fs.mkdirSync(userDir, { recursive: true });
      }
      
      // Determine file extension
      let extension = 'mp4';
      if (type === 'gif') {
          extension = 'gif';
      } else if (url.includes('.m3u8')) {
          extension = 'm3u8';
      }
      
      // Create the filename: username_tweetId_video_index.extension
      const filename = `${username}_${tweetId}_video_${index}.${extension}`;
      const filepath = path.join(userDir, filename);
      
      // Check if file already exists
      if (fs.existsSync(filepath)) {
          this.stats.skipped++;
          console.log(`Skipped existing video: ${filename}`);
          return filepath;
      }
      
      try {
          await this.downloadFile(url, filepath);
          this.stats.successful++;
          console.log(`Successfully downloaded video: ${filename}`);
          return filepath;
      } catch (error) {
          this.stats.failed++;
          throw new ScraperError(
              `Failed to download video ${url}: ${(error as Error).message}`,
              ScraperErrorType.DOWNLOAD_ERROR
          );
      }
  }
}
