const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---

// The base URL without the page parameter
const BASE_SEARCH_URL = 'https://sg.jobstreet.com/jobs/in-Singapore?classification=1203%2C6281&daterange=1&salaryrange=3000-&salarytype=monthly&subclassification=6185%2C6178%2C6285%2C6287%2C6290%2C6294%2C6302&worktype=242%2C244';

// Replace with your n8n Production Webhook URL
const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/jobstreet-ingest'; 


// Adding Random delay to act like a human and not a bot
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = async (min, max) => await delay(Math.floor(Math.random() * (max - min + 1) + min));



// Helper function to calculate exact date from "3d ago", "8h ago", etc.
function calculatePostedDate(relativeStr) {
    const now = new Date();
    if (!relativeStr) return now.toISOString().split('T')[0]; // Fallback to today

    const lowerStr = relativeStr.toLowerCase();
    
    if (lowerStr.includes('today')) {
        return now.toISOString().split('T')[0];
    }

    // Extract the number and the unit (d, h, m) using Regex
    const match = lowerStr.match(/(\d+)\s*(d|h|m)/);
    if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];

        if (unit === 'd') {
            now.setDate(now.getDate() - value);
        } else if (unit === 'h') {
            now.setHours(now.getHours() - value);
        } else if (unit === 'm') {
            now.setMinutes(now.getMinutes() - value);
        }
    }

    // Returns format: YYYY-MM-DD
    return now.toISOString().split('T')[0]; 
}

async function runScraper() {
    console.log('🚀 Starting Deep Local JobStreet Scraper...');
    
    const browser = await puppeteer.launch({
        headless: true, // Set to false so you can watch it work locally
        defaultViewport: null,
        args: ['--start-maximized', '--disable-notifications']
    });



    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');


    // caching file
    const CACHE_FILE = 'sg_scraped_jobs_cache.json';

    // Safely load cache
    let initialCache = [];
    if (fs.existsSync(CACHE_FILE)) {
        try {
            const fileContent = fs.readFileSync(CACHE_FILE, 'utf-8');
            // Only try to parse if the file actually has content
            if (fileContent.trim() !== '') {
                initialCache = JSON.parse(fileContent);
            }
        } catch (e) {
            console.warn('⚠️ Cache file was corrupted or empty. Starting a fresh cache.');
        }
    }
    
    const scrapedJobIds = new Set(initialCache);

    let currentPage = 1;
    let keepScraping = true;
    let totalJobsScraped = 0;



    try {
        while (keepScraping) {
            console.log(`\n📄 --- Navigating to Page ${currentPage} ---`);
            const pageUrl = `${BASE_SEARCH_URL}&page=${currentPage}`;
            
            await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Wait to see if job cards load. If it times out here, we likely hit the end of the results.
            try {
                await page.waitForSelector('a[data-automation="jobTitle"]', { timeout: 8000 });
            } catch (err) {
                console.log(`No jobs found on page ${currentPage}. Reached the end of the search results.`);
                keepScraping = false;
                break; // Exit the while loop
            }

            // Extract all job URLs from the current page
            const jobUrls = await page.$$eval('a[data-automation="jobTitle"]', links => 
                links.map(link => link.href)
            );

            if (jobUrls.length === 0) {
                console.log('Zero job links extracted. Ending pagination.');
                keepScraping = false;
                break;
            }

            console.log(`Found ${jobUrls.length} jobs on Page ${currentPage}. Beginning extraction...`);
            const jobsData = [];

            // Loop through each job URL on this specific page
            for (let i = 0; i < jobUrls.length; i++) {
                const canonicalUrl = jobUrls[i];
                console.log(`[Page ${currentPage} - ${i + 1}/${jobUrls.length}] Scraping: ${canonicalUrl.split('?')[0]}`); // Clean URL logging
                
                const jobId = canonicalUrl.split('?')[0]; // Use the clean URL as the unique ID

               // If we've already processed this job, skip to the next one instantly
                if (scrapedJobIds.has(jobId)) {
                    console.log(`⏩ Skipping already processed job: ${jobId}`);
                    continue; 
                }
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
                    
                    // Scan all spans and divs for the relative time text
                    $('span, div').each((i, el) => {
                        const text = $(el).text().trim().toLowerCase();
                        // Look for short strings containing " ago" or exactly "today"
                        if ((text.includes(' ago') || text === 'today') && text.length < 20 && /\d|today/.test(text)) {
                            relativeTimeText = text;
                            return false; // Break the loop once we find it
                        }
                    });

                    // Convert the found text (e.g., "3d ago") into a real date (e.g., "2026-04-09")
                    const postedDate = calculatePostedDate(relativeTimeText);

                    if (title) {
                        jobsData.push({
                            postedDate,
                            canonicalUrl,
                            jobId,
                            Title: title,
                            company,
                            location,
                            employmentType,
                            description
                        });
                        scrapedJobIds.add(jobId);
                        fs.writeFileSync(CACHE_FILE, JSON.stringify([...scrapedJobIds]));
                    }
                } catch (err) {
                    console.error(`Failed to scrape ${canonicalUrl}: ${err.message}`);
                } finally {
                    await detailPage.close();
                    await randomDelay(2000, 4000); // 2-4 second delay to avoid IP blocks
                }
            }

            // --- SEND BATCH TO n8n ---
            if (jobsData.length > 0) {
                console.log(`📦 Sending Batch of ${jobsData.length} jobs from Page ${currentPage} to n8n...`);
                try {
                    await axios.post(N8N_WEBHOOK_URL, {
                        metadata: {
                            source: "sg.jobstreet.com",
                            domain: "Broad IT & Eng (Filtered 3k+)",
                            batch_page: currentPage,
                            timestamp: new Date().toISOString(),
                            count: jobsData.length
                        },
                        jobs: jobsData
                    });
                    console.log('🎉 Batch successfully sent!');
                    totalJobsScraped += jobsData.length;
                } catch (webhookError) {
                    console.error('❌ Failed to send batch to n8n:', webhookError.message);
                }
            }

            // Move to the next page and add a slightly longer delay between pages to mimic human reading
            currentPage++;
            await randomDelay(5000, 8000); 
        }

        console.log(`\n✅ Scraping completely finished! Total jobs scraped and sent to n8n: ${totalJobsScraped}`);

    } catch (error) {
        console.error('❌ Scraper failed completely:', error);
    } finally {
        await browser.close();
    }
}

runScraper();