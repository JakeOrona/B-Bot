/**
 * Logger: Utility class for logging messages with timestamps
 * Supports dual file logging (concise and verbose)
 */

import fs from 'fs';
import path from 'path';
import { ScraperErrorType } from '../interfaces/ScraperTypes';

export class Logger {
  private static instance: Logger;
  private static additionalLoggers: Map<string, Logger> = new Map();
  private logFilePath: string;
  private isAdditionalLogger: boolean = false;
  
  /**
   * Private constructor for singleton pattern
   * @param logPath Optional specific log file path for additional loggers
   */
  private constructor(logPath?: string) {
    const logDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    if (logPath) {
      // For additional loggers, use the provided path
      this.logFilePath = logPath;
      this.isAdditionalLogger = true;
    } else {
      // Create a timestamped log file for the main logger
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.logFilePath = path.join(logDir, `scraper-${timestamp}.log`);
      
      // Initialize log file with header
      this.writeToFile('=== TWITTER/X IMAGE SCRAPER LOG ===');
      this.writeToFile(`Started: ${new Date().toLocaleString()}`);
      this.writeToFile('=====================================\n');
    }
  }
  
  /**
   * Get the singleton instance of the main logger
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }
  
  /**
   * Create an additional logger with a custom log file path
   * @param logPath Full path to the log file
   * @returns Logger instance for the additional log
   */
  public static createAdditionalLogger(logPath: string): Logger {
    // Check if we already have a logger for this path
    if (Logger.additionalLoggers.has(logPath)) {
      return Logger.additionalLoggers.get(logPath)!;
    }
    
    // Create new logger instance
    const logger = new Logger(logPath);
    Logger.additionalLoggers.set(logPath, logger);
    return logger;
  }
  
  /**
   * Log an informational message
   * @param message Message to log
   */
  public info(message: string): void {
    const formattedMessage = `[INFO] [${this.getTimestamp()}] ${message}`;
    console.log(formattedMessage);
    this.writeToFile(formattedMessage);
  }
  
  /**
   * Log a warning message
   * @param message Message to log
   */
  public warn(message: string): void {
    const formattedMessage = `[WARN] [${this.getTimestamp()}] ${message}`;
    console.warn(formattedMessage);
    this.writeToFile(formattedMessage);
  }
  
  /**
   * Log an error message
   * @param message Error message
   * @param error Error object
   */
  public error(message: string, error?: Error, type?: ScraperErrorType): void {
    const errorType = type ? `[${type}] ` : '';
    const errorMessage = error ? `: ${error.message}` : '';
    const formattedMessage = `[ERROR] ${errorType}[${this.getTimestamp()}] ${message}${errorMessage}`;
    
    console.error(formattedMessage);
    this.writeToFile(formattedMessage);
    
    // If there's a stack trace, also log it
    if (error && error.stack) {
      this.writeToFile(`Stack trace: ${error.stack}`);
    }
  }
  
  /**
   * Log a successful action
   * @param message Success message
   */
  public success(message: string): void {
    const formattedMessage = `[SUCCESS] [${this.getTimestamp()}] ${message}`;
    console.log(formattedMessage);
    this.writeToFile(formattedMessage);
  }
  
  /**
   * Write a message to the log file
   * @param message Message to write
   */
  private writeToFile(message: string): void {
    fs.appendFileSync(this.logFilePath, `${message}\n`);
  }
  
  /**
   * Get current timestamp for logs
   */
  private getTimestamp(): string {
    return new Date().toISOString();
  }
  
  /**
   * Get the absolute path of the log file for this logger
   * @returns Log file path
   */
  public getLogFilePath(): string {
    return this.logFilePath;
  }
  
  /**
   * Check if this is an additional logger
   * @returns True if this is an additional logger
   */
  public isSecondaryLogger(): boolean {
    return this.isAdditionalLogger;
  }
}
