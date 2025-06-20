/**
 * BasePage: Abstract base class for all page objects
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { Logger } from '../utilities/Logger';

export abstract class BasePage {
  protected page: Page;
  protected context: BrowserContext;
  protected browser: Browser;
  protected logger: Logger;
  
  /**
   * Constructor for the BasePage
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   */
  constructor(page: Page, context: BrowserContext, browser: Browser) {
    this.page = page;
    this.context = context;
    this.browser = browser;
    this.logger = Logger.getInstance();
  }
  
  /**
   * Navigate to a URL with retry mechanism
   * @param url The URL to navigate to
   * @param maxRetries Maximum number of retries
   * @param retryDelay Delay between retries in milliseconds
   */
  protected async navigateWithRetry(
    url: string, 
    maxRetries: number = 3, 
    retryDelay: number = 2000
  ): Promise<void> {
    let attempts = 0;
    
    while (attempts < maxRetries) {
      try {
        await this.page.goto(url, { waitUntil: 'networkidle' });
        this.logger.info(`Successfully navigated to: ${url}`);
        return;
      } catch (error) {
        attempts++;
        this.logger.warn(`Navigation attempt ${attempts}/${maxRetries} failed for ${url}`);
        
        if (attempts >= maxRetries) {
          throw error;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  /**
   * Wait for a selector with timeout
   * @param selector CSS selector to wait for
   * @param timeout Timeout in milliseconds
   */
  protected async waitForSelector(selector: string, timeout: number = 10000): Promise<void> {
    try {
      await this.page.waitForSelector(selector, { timeout });
    } catch (error) {
      this.logger.error(`Timeout waiting for selector: ${selector}`);
      throw error;
    }
  }
  
  /**
   * Take a screenshot and save it to file
   * @param name Name for the screenshot file
   */
  public async takeScreenshot(name: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}_${timestamp}.png`;
    const path = `./screenshots/${filename}`;
    
    await this.page.screenshot({ path, fullPage: true });
    this.logger.info(`Screenshot saved: ${path}`);
    return path;
  }
  
  /**
   * Get the current URL
   */
  public async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }
  
  /**
   * Get the page title
   */
  public async getPageTitle(): Promise<string> {
    return this.page.title();
  }
  
  /**
   * Check if an element exists on the page
   * @param selector CSS selector for the element
   */
  public async elementExists(selector: string): Promise<boolean> {
    const elements = await this.page.$$(selector);
    return elements.length > 0;
  }
  
  /**
   * Wait for a given amount of time
   * @param ms Time to wait in milliseconds
   */
  protected async wait(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
