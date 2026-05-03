import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://sayhentai.baby';

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://sayhentai.baby',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    timeout: 15000
};

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
        cache.delete(key);
        return null;
    }
    return item.data;
}

function setCache(key, data, ttl = CACHE_TTL) {
    cache.set(key, { data, expires: Date.now() + ttl });
}

// ─── Scraping functions ───────────────────────────────────────────

async function searchManga(query) {
    const cacheKey = `search:${query}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const url = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, axiosConfig);
    const $ = cheerio.load(data);
    const results = [];

    $('.halim-item').each((i, el) => {
        if (i >= 10) return;
        const title = $(el).find('.entry-title').text().trim();
        let link = $(el).find('a').attr('href');
        if (link && !link.startsWith('http')) link = BASE_URL + link;
        const thumbnail = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        if (title && link) results.push({ title, link, thumbnail });
    });

    setCache(cacheKey, results);
    return results;
}

async function getMangaDetail(url) {
    const cacheKey = `detail:${url}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const { data } = await axios.get(url, axiosConfig);
    const $ = cheerio.load(data);

    const title = $('.entry-title').text().trim();
    const thumbnail = $('.movie-poster img').attr('data-src') || $('.movie-poster img').attr('src');
    const genres = $('.the_tag_list a').map((i, el) => $(el).text().trim()).get().join(', ');
    const author = $('a[href*="/tac-gia/"]').map((i, el) => $(el).text().trim()).get().join(', ') || 'Đang cập nhật';

    const chapters = [];
    $('li.chapter a').each((i, el) => {
        const name = $(el).text().trim().split('\n')[0];
        let link = $(el).attr('href');
        if (link && !link.startsWith('http')) link = BASE_URL + link;
        if (name && link) chapters.push({ name, link });
    });

    chapters.reverse();

    const result = {
        title,
        thumbnail: thumbnail && !thumbnail.startsWith('http') ? BASE_URL + thumbnail : thumbnail,
        genres,
        author,
        chapters
    };

    setCache(cacheKey, result);
    return result;
}

async function getChapterImages(url, referer) {
    const cacheKey = `chapter:${url}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const { data } = await axios.get(url, {
        ...axiosConfig,
        headers: {
            ...axiosConfig.headers,
            'Referer': referer || BASE_URL,
        }
    });
    const $ = cheerio.load(data);
    const images = [];

    const selectors = [
        '.contentimg img',
        '.chapter-content img',
        '.reading-content img',
        '.page-chapter img',
        '#chapter-content img',
        '.content-chapter img',
        '.box-doc img',
        'article img',
    ];

    for (const selector of selectors) {
        $(selector).each((i, el) => {
            let src = $(el).attr('src')
                || $(el).attr('data-src')
                || $(el).attr('data-lazy-src')
                || $(el).attr('data-original')
                || $(el).attr('data-url');
            if (src && !src.includes('base64')) {
                if (!src.startsWith('http')) src = BASE_URL + src;
                if (!images.includes(src)) images.push(src);
            }
        });
        if (images.length > 0) break;
    }

    // Fallback: script tag
    if (images.length === 0) {
        const patterns = [
            /(?:chapter_images|pages|images|imgs)\s*=\s*(\[[\s\S]*?\])/,
            /var\s+(?:images|imgs|listImgs)\s*=\s*(\[[\s\S]*?\])/,
            /"(?:images|pages)"\s*:\s*(\[[\s\S]*?\])/,
        ];
        for (const pattern of patterns) {
            const match = data.match(pattern);
            if (match) {
                try {
                    const parsed = JSON.parse(match[1]);
                    for (let src of parsed) {
                        if (src && typeof src === 'string' && !src.includes('base64')) {
                            if (!src.startsWith('http')) src = BASE_URL + src;
                            images.push(src);
                        }
                    }
                    if (images.length > 0) break;
                } catch {}
            }
        }
    }

    // Fallback: scan all img
    if (images.length === 0) {
        $('img').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
            if (src && !src.includes('base64') && !src.includes('logo')) {
                if (src.match(/\.(jpg|jpeg|png|webp|gif)/i) || src.includes('wtcdn')) {
                    if (!src.startsWith('http')) src = BASE_URL + src;
                    if (!images.includes(src)) images.push(src);
                }
            }
        });
    }

    setCache(cacheKey, images, 5 * 60 * 1000); // 5 min for chapters
    return images;
}

// ─── Routes ──────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SayHentai API is running' });
});

// GET /search?q=tên truyện
app.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query param: q' });

    try {
        const results = await searchManga(q);
        res.json({ success: true, total: results.length, data: results });
    } catch (err) {
        console.error('[Search Error]', err.message);
        res.status(500).json({ error: 'Failed to search', message: err.message });
    }
});

// GET /manga?url=https://...
app.get('/manga', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing query param: url' });

    try {
        const detail = await getMangaDetail(url);
        res.json({ success: true, data: detail });
    } catch (err) {
        console.error('[Manga Detail Error]', err.message);
        res.status(500).json({ error: 'Failed to get manga detail', message: err.message });
    }
});

// GET /chapter?url=https://...&referer=https://...
app.get('/chapter', async (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing query param: url' });

    try {
        const images = await getChapterImages(url, referer);
        res.json({ success: true, total: images.length, data: images });
    } catch (err) {
        console.error('[Chapter Error]', err.message);
        res.status(500).json({ error: 'Failed to get chapter images', message: err.message });
    }
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`SayHentai API running on port ${PORT}`);
});
