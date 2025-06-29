/**
 * MediaDownloader: Utility class for downloading and saving images, videos, and GIFs
 * UPDATED: Renamed from ImageDownloader, added video/GIF support
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { MediaData, DownloadStats, ScraperError, ScraperErrorType, MediaType } from '../interfaces/ScraperTypes';

export class MediaDownloader {
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
      skipped: 0,
      // ADDED: Media type breakdown
      byType: {
        images: 0,
        videos: 0,
        gifs: 0
      }
    };
    
    // Ensure the download directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Download media from a URL (images, videos, GIFs)
   * @param mediaData Media data containing URL, tweet ID, username, index, and type
   * @returns Promise resolving to the path where the media was saved
   */
  public async downloadMedia(mediaData: MediaData): Promise<string> {
    const { url, tweetId, username, index, mediaType } = mediaData;
    this.stats.total++;
    
    // Create user-specific directory if it doesn't exist
    const userDir = path.join(this.baseDir, username);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Determine the file extension from the URL and media type
    const extension = this.determineFileExtension(url, mediaType);
    
    // Create the filename: username_tweetId_index.extension
    const filename = `${username}_${tweetId}_${index}.${extension}`;
    const filepath = path.join(userDir, filename);
    
    // Check if the file already exists
    if (fs.existsSync(filepath)) {
      this.stats.skipped++;
      this.incrementTypeCounter(mediaType, 'skipped');
      console.log(`Skipped existing ${mediaType}: ${filename}`);
      return filepath;
    }
    
    try {
      // Download the media
      await this.downloadFile(url, filepath);
      this.stats.successful++;
      this.incrementTypeCounter(mediaType, 'successful');
      console.log(`Successfully downloaded ${mediaType}: ${filename}`);
      return filepath;
    } catch (error) {
      this.stats.failed++;
      this.incrementTypeCounter(mediaType, 'failed');
      throw new ScraperError(
        `Failed to download ${mediaType} ${url}: ${(error as Error).message}`,
        ScraperErrorType.DOWNLOAD_ERROR
      );
    }
  }

  /**
   * Backward compatibility method for image downloads
   * DEPRECATED: Use downloadMedia instead
   */
  public async downloadImage(mediaData: MediaData): Promise<string> {
    return this.downloadMedia(mediaData);
  }

  /**
   * Determine appropriate file extension based on URL and media type
   * @param url Media URL
   * @param mediaType Type of media
   * @returns File extension
   */
  private determineFileExtension(url: string, mediaType: MediaType): string {
    // Try to extract extension from URL first
    const urlExtensionMatch = url.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm|m4v)(?:$|\?)/i);
    
    if (urlExtensionMatch) {
      const ext = urlExtensionMatch[1].toLowerCase();
      
      // Validate extension matches media type
      if (mediaType === MediaType.VIDEO && this.isVideoExtension(ext)) {
        return ext;
      } else if (mediaType === MediaType.GIF && ext === 'gif') {
        return ext;
      } else if (mediaType === MediaType.IMAGE && this.isImageExtension(ext)) {
        return ext;
      }
    }
    
    // Fallback to default extensions based on media type
    switch (mediaType) {
      case MediaType.VIDEO:
        return 'mp4';  // Most common video format on Twitter
      case MediaType.GIF:
        return 'gif';
      case MediaType.IMAGE:
      default:
        return 'jpg';  // Most common image format on Twitter
    }
  }

  /**
   * Check if extension is a valid video format
   * @param extension File extension
   * @returns Boolean indicating if it's a video format
   */
  private isVideoExtension(extension: string): boolean {
    const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'];
    return videoExtensions.includes(extension.toLowerCase());
  }

  /**
   * Check if extension is a valid image format
   * @param extension File extension
   * @returns Boolean indicating if it's an image format
   */
  private isImageExtension(extension: string): boolean {
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    return imageExtensions.includes(extension.toLowerCase());
  }

  /**
   * Increment type-specific counters
   * @param mediaType Type of media
   * @param operation Operation performed (successful, failed, skipped)
   */
  private incrementTypeCounter(mediaType: MediaType, operation: 'successful' | 'failed' | 'skipped'): void {
    // Only count successful downloads in type breakdown
    if (operation === 'successful') {
      switch (mediaType) {
        case MediaType.IMAGE:
          this.stats.byType.images++;
          break;
        case MediaType.VIDEO:
          this.stats.byType.videos++;
          break;
        case MediaType.GIF:
          this.stats.byType.gifs++;
          break;
      }
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
        
        // Check content type for additional validation
        const contentType = response.headers['content-type'];
        if (contentType) {
          this.validateContentType(contentType, outputPath);
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
   * Validate content type matches expected file type
   * @param contentType HTTP content type header
   * @param filePath Output file path for context
   */
  private validateContentType(contentType: string, filePath: string): void {
    const fileExtension = path.extname(filePath).toLowerCase();
    
    // Basic content type validation (warn if mismatch)
    if (contentType.startsWith('video/') && !this.isVideoExtension(fileExtension.substring(1))) {
      console.warn(`Content type mismatch: ${contentType} for file ${filePath}`);
    } else if (contentType.startsWith('image/') && !this.isImageExtension(fileExtension.substring(1))) {
      console.warn(`Content type mismatch: ${contentType} for file ${filePath}`);
    }
  }

  /**
   * Get current download statistics
   * @returns Current download stats with type breakdown
   */
  public getStats(): DownloadStats {
    return { 
      ...this.stats,
      byType: { ...this.stats.byType }
    };
  }

  /**
   * Reset statistics
   * ADDED: Method to reset counters
   */
  public resetStats(): void {
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      byType: {
        images: 0,
        videos: 0,
        gifs: 0
      }
    };
  }
}