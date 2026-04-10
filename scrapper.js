const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');

// Enable stealth mode to bypass basic anti-bot protections
puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
// JobStreet SG URL for jobs posted in the last 1 day (daterange=1)
const SEARCH_URL = 'https://sg.jobstreet.com/jobs/in-Singapore?classification=1203%2C6281&daterange=1&salaryrange=3000-&salarytype=monthly&subclassification=6185%2C6180%2C6178%2C6285%2C6287%2C6290%2C6294%2C6302&worktype=242%2C244';
// Replace this with your n8n Webhook URL
const N8N_WEBHOOK_URL = 'https://play.svix.com/in/e_kvj1QZ6hyh4AD3hp7DQ6vGVLmEW/'; 

// Helper function to introduce random delays to mimic human behavior
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = async (min, max) => await delay(Math.floor(Math.random() * (max - min + 1) + min));

async function runScraper() {
    console.log('🚀 Starting JobStreet Scraper...');
    
    const browser = await puppeteer.launch({
        headless: "new", // Use the new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Set a standard user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        console.log(`Navigating to ${SEARCH_URL}...`);
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for the job cards to load
        await page.waitForSelector('a[data-automation="jobTitle"]', { timeout: 30000 });
        // await page.waitForSelector('a[data-automation="jobTitle"]', { timeout: 15000 });

        // Extract all job URLs from the search page
        const jobUrls = await page.$$eval('a[data-automation="jobTitle"]', links => 
            links.map(link => link.href)
        );

        console.log(`Found ${jobUrls.length} jobs. Beginning extraction...`);
        const jobsData = [];

        // Loop through each job URL to extract detailed information
        for (let i = 0; i < jobUrls.length; i++) {
            const canonicalUrl = jobUrls[i];
            console.log(`[${i + 1}/${jobUrls.length}] Scraping: ${canonicalUrl}`);
            
            const detailPage = await browser.newPage();
            try {
                await detailPage.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                
                // We use cheerio here because parsing raw HTML is much faster than running Puppeteer DOM commands
                const html = await detailPage.content();
                const $ = cheerio.load(html);

                // Extracting using SEEK/JobStreet's standard data-automation tags
                const title = $('h1[data-automation="job-detail-title"]').text().trim() || null;
                const company = $('span[data-automation="advertiser-name"]').text().trim() || null;
                const location = $('span[data-automation="job-detail-location"]').text().trim() || null;
                const employmentType = $('span[data-automation="job-detail-work-type"]').text().trim() || null;
                
                // Description usually contains HTML. We can extract raw text, or keep HTML if you want to retain formatting for emails/notion
                const description = $('div[data-automation="jobAdDetails"]').text().trim() || null;

                if (title) {
                    jobsData.push({
                        canonicalUrl,
                        Title: title,
                        company,
                        location,
                        employmentType,
                        description
                    });
                }
            } catch (err) {
                console.error(`Failed to scrape ${canonicalUrl}: ${err.message}`);
            } finally {
                await detailPage.close();
                // Crucial: Wait 2-5 seconds between requests to avoid rate limiting/IP bans
                await randomDelay(2000, 5000); 
            }
        }

        console.log(`✅ Scraping complete. Successfully extracted ${jobsData.length} jobs.`);


        // --- SEND DATA TO n8n ---
        if (jobsData.length > 0) {
            console.log('Sending payload to n8n webhook...');
            await axios.post(N8N_WEBHOOK_URL, {
                metadata: {
                    source: "sg.jobstreet.com",
                    domain: "Broad IT & Eng (Filtered 3k+)",
                    timestamp: new Date().toISOString(),
                    count: jobsData.length
                },
                jobs: jobsData
            });
            console.log('🎉 Data successfully sent to n8n!');
        } else {
            console.log('No jobs found to send.');
        }

    } catch (error) {
        console.error('❌ Scraper failed:', error.message);
        
        // DEBUGGING: Let's see what the bot is actually looking at!
        try {
            const pageTitle = await page.title();
            console.log('🔍 The page title was:', pageTitle);
            
            // Grab the first 500 characters of text on the screen
            const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
            console.log('📄 Page text snippet:\n', pageText);
        } catch (e) {
            console.log('Could not extract page text.');
        }

    } finally {
        await browser.close();
    }
}

runScraper();
