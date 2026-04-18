const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs');

// Enable stealth mode to bypass Cloudflare/Jora bot protections
puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
// Jora SG URL for Software Engineer in Singapore
const BASE_SEARCH_URL = 'https://sg.jora.com/j?sp=search&trigger_source=serp&r=100&sa=50000&jt=3&a=24h&q=software&l=Singapore';

// Using your EXISTING Singapore JobStreet Webhook!
const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/jobstreet-ingest'; 

// A dedicated cache file just for Jora
const CACHE_FILE = 'sg_jora_scraped_jobs_cache.json';
const scrapedJobIds = new Set(fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE)) : []);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = async (min, max) => await delay(Math.floor(Math.random() * (max - min + 1) + min));

// Intelligent relative date calculator
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
    console.log('🚀 Starting Jora SG Scraper...');
    
    const browser = await puppeteer.launch({
        headless: true, // Run visible to avoid immediate bot detection
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
            console.log(`\n📄 --- Navigating to Jora Page ${currentPage} ---`);
            // Jora handles pagination with the &p= parameter
            const pageUrl = `${BASE_SEARCH_URL}&p=${currentPage}`;
            
            await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 50000 });
            
            // Extract all job links by finding URLs that include '/job/'
            const rawJobUrls = await page.$$eval('a', links => 
                links.map(link => link.href).filter(href => href.includes('/job/'))
            );

            // Deduplicate URLs on the search page
            const jobUrls = [...new Set(rawJobUrls)];

            if (jobUrls.length === 0) {
                console.log(`No job links found on page ${currentPage}. Ending pagination.`);
                keepScraping = false;
                break;
            }

            console.log(`Found ${jobUrls.length} jobs on Page ${currentPage}. Beginning extraction...`);
            const jobsData = [];

            for (let i = 0; i < jobUrls.length; i++) {
                const canonicalUrl = jobUrls[i];
                // Jora URLs are long, so we split at the query parameters to get a clean ID
                const jobId = canonicalUrl.split('?')[0]; 

                if (scrapedJobIds.has(jobId)) {
                    console.log(`⏩ Skipping cached Jora job: ${jobId.substring(0, 60)}...`);
                    continue; 
                }

                console.log(`[Page ${currentPage} - ${i + 1}/${jobUrls.length}] Scraping Jora Job...`);
                
                const detailPage = await browser.newPage();
                try {
                    await detailPage.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    
                    const html = await detailPage.content();
                    const $ = cheerio.load(html);

                    // Jora Generic Selectors
                    const title = $('h1').first().text().trim() || null;
                    const company = $('.job-company').first().text().trim() || "Company not specified";   
                    const location = $('.job-location').first().text().trim() || "Singapore";
                    const employmentType = $('.badge, .job-type, [class*="badge"]').first().text().trim() || "Full Time";
                    
                    // Description usually sits in an article or a container with 'description'
                    const description = $('#job-description-container, .job-description, .summary, article').text().trim() || null;

                    // Intelligent Date Extraction
                    let relativeTimeText = "";
                    $('span, div, p').each((i, el) => {
                        const text = $(el).text().trim().toLowerCase();
                        if ((text.includes(' ago') || text === 'today') && text.length < 20 && /\d|today/.test(text)) {
                            relativeTimeText = text;
                            return false;
                        }
                    });

                    const postedDate = calculatePostedDate(relativeTimeText);

                    if (title && description) {
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
                        
                        // Save to Jora cache
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

            // --- SEND BATCH TO n8n ---
            if (jobsData.length > 0) {
                console.log(`📦 Sending Batch of ${jobsData.length} Jora jobs to n8n...`);
                try {
                    await axios.post(N8N_WEBHOOK_URL, {
                        metadata: {
                            source: "sg.jora.com",
                            domain: "Software Engineer",
                            batch_page: currentPage,
                            timestamp: new Date().toISOString(),
                            count: jobsData.length
                        },
                        jobs: jobsData
                    });
                    console.log('🎉 Jora Batch successfully sent!');
                    totalJobsScraped += jobsData.length;
                } catch (webhookError) {
                    console.error('❌ Failed to send batch to n8n:', webhookError.message);
                }
            }

            currentPage++;
            await randomDelay(5000, 8000); 
        }

        console.log(`\n✅ Jora Scraping completely finished! Total jobs sent: ${totalJobsScraped}`);

    } catch (error) {
        console.error('❌ Jora Scraper failed completely:', error);
    } finally {
        await browser.close();
    }
}

runScraper();