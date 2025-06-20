/**
 * TwitterAuth: Page object for Twitter/X authentication
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { AuthCredentials, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import fs from 'fs';
import path from 'path';

export class TwitterAuth extends BasePage {
  private readonly loginUrl: string = 'https://x.com/login';
  private readonly cookiesPath: string = path.join(process.cwd(), 'config', 'twitter_cookies.json');
  
  /**
   * Constructor for TwitterAuth
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   */
  constructor(page: Page, context: BrowserContext, browser: Browser) {
    super(page, context, browser);
  }
  
  /**
   * Login to Twitter with username and password
   * @param credentials Twitter login credentials
   */
  public async login(credentials: AuthCredentials): Promise<void> {
    try {
      // First check if we can use saved cookies
      if (await this.loadCookies()) {
        // Verify login was successful
        if (await this.verifyLoggedIn()) {
          this.logger.success('Successfully logged in with saved cookies');
          return;
        }
      }
      
      // If cookies didn't work, do a full login
      await this.performFullLogin(credentials);
      
      // Save cookies for future use
      await this.saveCookies();
    } catch (error) {
      this.logger.error('Login failed', error as Error, ScraperErrorType.AUTHENTICATION_ERROR);
      throw new ScraperError(
        `Failed to log in to Twitter: ${(error as Error).message}`,
        ScraperErrorType.AUTHENTICATION_ERROR
      );
    }
  }
  
  /**
   * Load saved cookies if available
   * @returns true if cookies were loaded successfully
   */
  private async loadCookies(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.cookiesPath)) {
        this.logger.info('No saved cookies found');
        return false;
      }
      
      const cookiesString = fs.readFileSync(this.cookiesPath, 'utf8');
      const cookies = JSON.parse(cookiesString);
      
      if (!Array.isArray(cookies) || cookies.length === 0) {
        this.logger.info('Invalid or empty cookies file');
        return false;
      }
      
      await this.context.addCookies(cookies);
      this.logger.info('Loaded saved cookies');
      
      // Navigate to Twitter homepage to verify cookies
      await this.navigateWithRetry('https://twitter.com/home');
      
      return true;
    } catch (error) {
      this.logger.warn(`Error loading cookies: ${(error as Error).message}`);
      return false;
    }
  }
  
  /**
   * Save current cookies for future use
   */
  private async saveCookies(): Promise<void> {
    try {
      const cookies = await this.context.cookies();
      const cookiesString = JSON.stringify(cookies, null, 2);
      
      // Ensure the directory exists
      const cookiesDir = path.dirname(this.cookiesPath);
      if (!fs.existsSync(cookiesDir)) {
        fs.mkdirSync(cookiesDir, { recursive: true });
      }
      
      fs.writeFileSync(this.cookiesPath, cookiesString);
      this.logger.info('Saved cookies for future use');
    } catch (error) {
      this.logger.warn(`Failed to save cookies: ${(error as Error).message}`);
    }
  }
  
  /**
   * Perform a full login using the provided credentials
   * @param credentials Twitter login credentials
   */
  private async performFullLogin(credentials: AuthCredentials): Promise<void> {
    // Navigate to login page
    await this.navigateWithRetry(this.loginUrl);
    
    // Wait for the login form
    await this.page.getByRole('textbox', { name: 'Phone, email, or username' }).waitFor({ state: 'visible' });

    // Fill in username
    await this.page.getByRole('textbox', { name: 'Phone, email, or username' }).fill(credentials.username);
    await this.page.getByRole('button', { name: 'Next' }).click();

    // Check for verification challenge (unusual login activity)
    const hasVerificationChallenge = await this.elementExists('input[data-testid="ocfEnterTextTextInput"]');
    if (hasVerificationChallenge) {
      await this.handleVerificationChallenge(credentials);
    }
    
    // Wait for password field
    await this.waitForSelector('input[name="password"]');
    
    // Fill in password
    await this.page.getByRole('textbox', { name: 'password' }).fill(credentials.password);
    await this.page.getByTestId('LoginForm_Login_Button').click();

    // Wait for navigation to complete
    await this.page.waitForTimeout(1000); // Wait a bit for the login process to complete
    
    // Handle 2FA if needed
    await this.handle2FA();
    
    // Verify successful login
    if (!(await this.verifyLoggedIn())) {
      throw new ScraperError('Login failed - unable to verify successful login', ScraperErrorType.AUTHENTICATION_ERROR);
    }
    
    this.logger.success('Successfully logged in to Twitter');
  }
  
  /**
   * Handle the verification challenge for unusual login activity
   * @param credentials Twitter login credentials
   */
  private async handleVerificationChallenge(credentials: AuthCredentials): Promise<void> {
    this.logger.info('Detected verification challenge');
    
    // Enter username or email in the verification field
    await this.page.getByTestId('ocfEnterTextTextInput').fill(credentials.username);
    await this.page.getByTestId('ocfEnterTextNextButton').click();

    // Wait for the challenge to be processed
    await this.page.waitForLoadState('networkidle');
    
    this.logger.info('Completed verification challenge');
  }
  
  /**
   * Handle 2FA if required
   */
  private async handle2FA(): Promise<void> {
    // Check if 2FA input is present
    const has2FA = await this.elementExists('input[data-testid="LoginForm_CodeInput"]');
    
    if (!has2FA) {
      return; // No 2FA required
    }
    
    this.logger.info('2FA verification required');
    
    // Prompt user to enter 2FA code manually
    // In a headless mode, this would be a problem, but we'll watch for code input
    
    // Wait for the 2FA code to be entered (max 60 seconds)
    try {
      await this.page.waitForNavigation({ timeout: 60000 });
      this.logger.info('2FA verification completed');
    } catch (error) {
      throw new ScraperError('2FA verification timed out', ScraperErrorType.AUTHENTICATION_ERROR);
    }
  }
  
  /**
   * Verify if successfully logged in
   */
  private async verifyLoggedIn(): Promise<boolean> {
    try {
      // Check for elements that should be present after login
      const isLoggedIn = await this.page.getByTestId('AppTabBar_Home_Link').isVisible();
      return isLoggedIn;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Logout from Twitter
   */
  public async logout(): Promise<void> {
    try {
      // Click on account menu
      await this.page.getByTestId('SideNav_AccountSwitcher_Button').click();
      
      // Click on logout option
      await this.page.getByTestId('AccountSwitcher_Logout_Button').click();
      
      // Confirm logout
      await this.page.getByTestId('confirmationSheetConfirm').click();

      // Wait for logout to complete
      await this.page.waitForTimeout(1000); // Wait a bit for the logout process to complete

      this.logger.info('Successfully logged out from Twitter');
    } catch (error) {
      this.logger.warn(`Logout failed: ${(error as Error).message}`);
      // Even if logout fails, we'll delete the cookies
    }
    
    // Delete saved cookies
    try {
      if (fs.existsSync(this.cookiesPath)) {
        fs.unlinkSync(this.cookiesPath);
        this.logger.info('Removed saved cookies');
      }
    } catch (error) {
      this.logger.warn(`Failed to remove cookies file: ${(error as Error).message}`);
    }
  }
}
