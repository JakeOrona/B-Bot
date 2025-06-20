/**
 * ConfigManager: Handles loading configuration for the scraper
 * - Loads artist usernames from file
 * - Loads environment variables
 * - Provides default configuration values
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { AuthCredentials, ScraperConfig, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';

export class ConfigManager {
  private static instance: ConfigManager;
  private readonly configDir: string;
  private readonly artistsFile: string;
  
  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    this.configDir = path.join(process.cwd(), 'config');
    this.artistsFile = path.join(this.configDir, 'artists.txt');
    
    // Load environment variables
    dotenv.config({ path: path.join(this.configDir, '.env') });
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Load artist usernames from the configuration file
   * @returns Array of artist usernames
   */
  public loadArtists(): string[] {
    try {
      if (!fs.existsSync(this.artistsFile)) {
        throw new ScraperError(
          `Artists file not found at: ${this.artistsFile}`, 
          ScraperErrorType.CONFIG_ERROR
        );
      }
      
      const fileContent = fs.readFileSync(this.artistsFile, 'utf-8');
      const artists = fileContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'));
      
      if (artists.length === 0) {
        throw new ScraperError(
          'No artists found in the configuration file', 
          ScraperErrorType.CONFIG_ERROR
        );
      }
      
      return artists;
    } catch (error) {
      if (error instanceof ScraperError) {
        throw error;
      }
      throw new ScraperError(
        `Error loading artists file: ${(error as Error).message}`, 
        ScraperErrorType.CONFIG_ERROR
      );
    }
  }

  /**
   * Get authentication credentials from environment variables
   * @returns Authentication credentials
   */
  public getAuthCredentials(): AuthCredentials {
    const username = process.env.TWITTER_USERNAME;
    const password = process.env.TWITTER_PASSWORD;
    
    if (!username || !password) {
      throw new ScraperError(
        'Missing Twitter authentication credentials in environment variables', 
        ScraperErrorType.AUTHENTICATION_ERROR
      );
    }
    
    return { username, password };
  }

  /**
   * Get default scraper configuration
   * @returns Scraper configuration with default values
   */
  public getScraperConfig(): ScraperConfig {
    const downloadPath = path.join(process.cwd(), 'downloads');
    
    // Create downloads directory if it doesn't exist
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }
    
    return {
      headless: process.env.HEADLESS !== 'false', // Default to true
      downloadPath,
      delayBetweenScrolls: parseInt(process.env.DELAY_BETWEEN_SCROLLS || '1000', 10),
      maxScrolls: parseInt(process.env.MAX_SCROLLS || '10', 10),
      rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY || '2000', 10),
      maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.RETRY_DELAY || '5000', 10)
    };
  }
  
  /**
   * Create default configuration files if they don't exist
   */
  public createDefaultConfigFiles(): void {
    // Create config directory if it doesn't exist
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    
    // Create default artists.txt file if it doesn't exist
    if (!fs.existsSync(this.artistsFile)) {
      const defaultContent = 
        '# Add Twitter/X artist usernames below (one per line)\n' +
        '# Lines starting with # are comments and will be ignored\n' +
        'artist1\n' +
        'artist2\n' +
        'artist3\n';
      
      fs.writeFileSync(this.artistsFile, defaultContent);
    }
    
    // Create default .env file if it doesn't exist
    const envFilePath = path.join(this.configDir, '.env');
    if (!fs.existsSync(envFilePath)) {
      const defaultEnv = 
        '# Twitter/X Authentication\n' +
        'TWITTER_USERNAME=your_username\n' +
        'TWITTER_PASSWORD=your_password\n\n' +
        '# Scraper Configuration\n' +
        'HEADLESS=true\n' +
        'DELAY_BETWEEN_SCROLLS=1000\n' +
        'MAX_SCROLLS=10\n' +
        'RATE_LIMIT_DELAY=2000\n' +
        'MAX_RETRIES=3\n' +
        'RETRY_DELAY=5000\n';
      
      fs.writeFileSync(envFilePath, defaultEnv);
    }
  }
}
