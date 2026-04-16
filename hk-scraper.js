const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// --- CONFIGURATION FOR HONG KONG ---
// JobsDB HK URL with the same IT/Engineering classifications applied
const BASE_SEARCH_URL = 'https://hk.jobsdb.com/jobs/in-Hong-kong?classification=1203%2C6281&daterange=2&salaryrange=20000-&salarytype=monthly&subclassification=6285%2C6287%2C6290%2C6302%2C6294%2C6185%2C6178&worktype=242%2C244';

// Use a NEW Webhook path for the HK workflow
const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/jobsdb-ingest'; 

// Use a SEPARATE cache file so SG and HK jobs don't mix
const CACHE_FILE = 'hk_scraped_jobs_cache.json';

const scrapedJobIds = new Set(fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE)) : []);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = async (min, max) => await delay(Math.floor(Math.random() * (max - min + 1) + min));

// Helper function to calculate exact date
function calculatePostedDate(relativeStr) {
    const now = new Date();
    if (!relativeStr) return now.toISOString().split('T')[0];

    const lowerStr = relativeStr.toLowerCase();
    if (lowerStr.includes('today')) return now.toISOString().split('T')[0];

    const match = lowerStr.match(/(\d+)\s*(d|h|m)/);
    if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        if (unit === 'd') now.setDate(now.getDate() - value);
        else if (unit === 'h') now.setHours(now.getHours() - value);
        else if (unit === 'm') now.setMinutes(now.getMinutes() - value);
    }
    return now.toISOString().split('T')[0]; 
}

async function runScraper() {
    console.log('🚀 Starting HK JobsDB Scraper...');
    
    const browser = await puppeteer.launch({
        headless: true, 
        defaultViewport: null,
        args: ['--start-maximized', '--disable-notifications']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let currentPage = 1;
    let keepScraping = true;
    let totalJobsScraped = 0;

    try {
        while (keepScraping) {
            console.log(`\n📄 --- Navigating to HK Page ${currentPage} ---`);
            const pageUrl = `${BASE_SEARCH_URL}&page=${currentPage}`;
            
            await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            try {
                await page.waitForSelector('a[data-automation="jobTitle"]', { timeout: 10000 });
            } catch (err) {
                console.log(`No jobs found on page ${currentPage}. Reached the end.`);
                keepScraping = false;
                break; 
            }

            const jobUrls = await page.$$eval('a[data-automation="jobTitle"]', links => links.map(link => link.href));

            if (jobUrls.length === 0) {
                keepScraping = false;
                break;
            }

            const jobsData = [];

            for (let i = 0; i < jobUrls.length; i++) {
                const canonicalUrl = jobUrls[i];
                const jobId = canonicalUrl.split('?')[0];

                if (scrapedJobIds.has(jobId)) {
                    console.log(`⏩ Skipping cached HK job: ${jobId}`);
                    continue; 
                }

                console.log(`[Page ${currentPage} - ${i + 1}/${jobUrls.length}] Scraping: ${jobId}`);
                
                const detailPage = await browser.newPage();
                try {
                    await detailPage.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    
                    const html = await detailPage.content();
                    const $ = cheerio.load(html);

                    const title = $('h1[data-automation="job-detail-title"]').text().trim() || null;
                    const company = $('span[data-automation="advertiser-name"]').text().trim() || null;
                    const location = $('span[data-automation="job-detail-location"]').text().trim() || null;
                    const employmentType = $('span[data-automation="job-detail-work-type"]').text().trim() || null;
                    const description = $('div[data-automation="jobAdDetails"]').text().trim() || null;

                    let relativeTimeText = "";
                    $('span, div').each((i, el) => {
                        const text = $(el).text().trim().toLowerCase();
                        if ((text.includes(' ago') || text === 'today') && text.length < 20 && /\d|today/.test(text)) {
                            relativeTimeText = text;
                            return false;
                        }
                    });

                    const postedDate = calculatePostedDate(relativeTimeText);

                    if (title) {
                        jobsData.push({
                            jobId,
                            canonicalUrl,
                            Title: title,
                            company,
                            location,
                            employmentType,
                            description,
                            postedDate
                        });
                        
                        scrapedJobIds.add(jobId);
                        fs.writeFileSync(CACHE_FILE, JSON.stringify([...scrapedJobIds]));
                    }
                } catch (err) {
                    console.error(`Failed to scrape ${canonicalUrl}: ${err.message}`);
                } finally {
                    await detailPage.close();
                    await randomDelay(2000, 4000); 
                }
            }

            if (jobsData.length > 0) {
                console.log(`📦 Sending Batch of ${jobsData.length} HK jobs to n8n...`);
                try {
                    await axios.post(N8N_WEBHOOK_URL, {
                        metadata: {
                            source: "hk.jobsdb.com",
                            domain: "Broad IT & Eng",
                            batch_page: currentPage,
                            timestamp: new Date().toISOString(),
                            count: jobsData.length
                        },
                        jobs: jobsData
                    });
                    console.log('🎉 HK Batch successfully sent!');
                    totalJobsScraped += jobsData.length;
                } catch (webhookError) {
                    console.error('❌ Failed to send batch to n8n:', webhookError.message);
                }
            }
            currentPage++;
            await randomDelay(5000, 8000); 
        }
        console.log(`\n✅ HK Scraping finished! Total new jobs sent: ${totalJobsScraped}`);
    } catch (error) {
        console.error('❌ HK Scraper failed completely:', error);
    } finally {
        await browser.close();
    }
}

runScraper();