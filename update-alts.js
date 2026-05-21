import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import fs from 'fs';

const START = parseInt(process.env.START || '1', 10);   // 1-based, inclusive
const END   = parseInt(process.env.END   || '13', 10);  // 1-based, inclusive
const BLOG_ID   = parseInt(process.env.BLOG_ID);        // Blog_ID
const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) throw new Error('Missing HUBSPOT_TOKEN in .env');

const BASE = 'https://api.hubapi.com/cms/blogs/2026-03/posts';
const HEADERS = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
};

const DRY_RUN = true;      // ← set to false to actually update drafts - true
const limit = pLimit(3); // max 3 concurrent requests


// --- Clean up text: collapse whitespace, decode entities, strip tags ---
function cleanText(raw = '') {
    return raw
        .replace(/\u00a0/g, ' ')                            // non-breaking space
        .replace(/[\u2018\u2019]/g, "'")                    // smart single quotes
        .replace(/[\u201C\u201D]/g, '"')                    // smart double quotes
        .replace(/^\s*\.\s*/, '')                           // remove leading dot like ". Aiva"
        .replace(/\s*\((copy|\d+)\)/gi, '')                 // remove (Copy) and numeric brackets like (1)
        .replace(/[-_ ]?\d{2,5}x\d{2,5}/gi, '')             // remove dimensions like 1200x628
        .replace(/[-_ ]?[a-f0-9]{6,}/gi, '')                // remove long random hashes/ids
        .replace(/[-_ ]?\d+/g, '')                          // remove standalone numbers
        .replace(/[-_]+/g, ' ')                             // replace separators with spaces
        .replace(/\s+/g, ' ')                               // collapse multiple spaces
        .trim();                                            // trim spaces
}

// --- Normalize SHOUTY HEADINGS to title case ---
function normalizeCase(text) {
    if (!text) return text;
    // If more than 60% uppercase letters, treat as shouty
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length > 4) {
        const upper = letters.replace(/[^A-Z]/g, '').length;
        if (upper / letters.length > 0.6) {
            return text.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
        }
    }
    return text;
}

// --- Is this an <img> we should skip (tracking pixels, tiny, SVG icons)? ---
function shouldSkipImage($el) {
    const src = ($el.attr('src') || '').trim();
    if (!src) return true;
    if (src.startsWith('data:')) return true;                  // inline data URIs
    if (/\.svg(\?|$)/i.test(src)) return true;                 // SVG icons
    const w = parseInt($el.attr('width') || '0', 10);
    const h = parseInt($el.attr('height') || '0', 10);
    if (w && w <= 2) return true;                              // tracking pixel
    if (h && h <= 2) return true;
    return false;
}

// --- Try <figcaption> first (image is often inside <figure>) ---
function findFigcaption($, $img) {
    const $fig = $img.closest('figure');
    if (!$fig.length) return null;
    const cap = cleanText($fig.find('figcaption').first().text());
    return cap || null;
}

// --- Walk backwards looking for the nearest heading text ---
function findNearestHeadingText($, $img) {
    // Bail if image is itself inside a heading
    if ($img.closest('h1, h2, h3, h4, h5, h6').length) return null;

    let node = $img[0];
    const MAX_HOPS = 200; // safety against deeply broken markup
    let hops = 0;

    while (node && hops < MAX_HOPS) {
        let sibling = node.prev;
        while (sibling && hops < MAX_HOPS) {
            hops++;
            if (sibling.type === 'tag') {
                const $sib = $(sibling);

                if (/^h[2-4]$/i.test(sibling.name)) {
                    const text = cleanText($sib.text());
                    if (text) return text;
                }

                const $headings = $sib.find('h2, h3, h4');
                if ($headings.length) {
                    // Walk from last to first; skip empty ones
                    for (let i = $headings.length - 1; i >= 0; i--) {
                        const text = cleanText($($headings[i]).text());
                        if (text) return text;
                    }
                }
            }
            sibling = sibling.prev;
        }
        node = node.parent;
    }
    return null;
}

// --- Filename fallback, with cleanup for WP suffixes ---
function altFromFilename(src = '') {
    let file = src.split('/').pop().split('?')[0];
    file = file
        .replace(/\.[^/.]+$/, '')                  // extension
        .replace(/-\d+x\d+$/, '')                  // WP resize suffix e.g. -300x200
        .replace(/-scaled$/, '')                   // WP -scaled suffix
        .replace(/-\d{6,}$/, '')                   // trailing IDs/timestamps
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleanText(file).replace(/\b\w/g, l => l.toUpperCase());
}

// --- Final alt builder with priority order ---
function buildAlt($, $img) {
    const candidates = [
        findFigcaption($, $img),
        $img.attr('title'),                        // sometimes WP populates title
        findNearestHeadingText($, $img),
        altFromFilename($img.attr('src')),
    ];

    for (let raw of candidates) {
        if (!raw) continue;
        let text = cleanText(raw);
        text = normalizeCase(text);
        if (text && text.length >= 3) {
            return text.slice(0, 125);
        }
    }
    return 'Image'; // last-resort fallback
}


// --- Generate alt text from <img src> ---
function generateAlt(src = '') {
    const file = src.split('/').pop().split('?')[0];

    return file
        // remove extension
        .replace(/\.[^/.]+$/, '')

        // remove dimensions like 1200x628
        .replace(/[-_ ]?\d{2,5}x\d{2,5}/gi, '')

        // remove long random hashes/ids
        .replace(/[-_ ]?[a-f0-9]{6,}/gi, '')

        // remove standalone numbers
        .replace(/[-_ ]?\d+/g, '')

        // replace separators with spaces
        .replace(/[-_]+/g, ' ')

        // collapse multiple spaces
        .replace(/\s+/g, ' ')

        // trim spaces
        .trim()

        // capitalize words
        .replace(/\b\w/g, l => l.toUpperCase());
}

// --- Fetch wrapper with 429 retry/backoff ---
async function api(path, opts = {}, attempt = 1) {
    const res = await fetch(`${BASE}${path}`, { ...opts, headers: HEADERS });
    if (res.status === 429 && attempt < 6) {
        const wait = Math.min(1000 * 2 ** attempt, 30000);
        console.warn(`429 received, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        return api(path, opts, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
}

// --- List all posts (generator) ---
// async function* listAllPosts() {
//     let after;
//     do {
//         const qs = new URLSearchParams({
//             limit: '100',
//             property: 'id,name,postBody',
//             contentGroupId: process.env.BLOG_ID,
//         });
//         if (after) qs.set('after', after);
//         const data = await api(`?${qs}`);
//         for (const p of data.results) yield p;
//         after = data.paging?.next?.after;
//     } while (after);
// }

// New Code Replacing listAllPosts with fetchPostsInRange for doing it in batchs of 13 posts

async function fetchPostsInRange() {
  const all = [];
  let after;

  do {
    const qs = new URLSearchParams({
      limit: '100',
      property: 'id,name,postBody,publishDate',
      sort: '-publishDate',         // newest first — matches typical blog listing
    });
    if (BLOG_ID) qs.set('contentGroupId', BLOG_ID);
    if (after)   qs.set('after', after);

    const data = await api(`?${qs}`);
    all.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);

  console.log(`Total posts in blog: ${all.length}`);
  console.log(`Processing posts ${START}–${END} (1-based, inclusive)`);

  // Slice: START/END are 1-based inclusive
  return all.slice(START - 1, END);
}

// --- Rewrite postBody; return new HTML or null if nothing changed ---
function rewriteBody(html) {
    const $ = cheerio.load(html || '', null, false);
    let altsAdded = 0;
    let lazyAdded = 0;
    const samples = [];

    $('img').each((_, el) => {
        const $el = $(el);

        if (shouldSkipImage($el)) return;

        const alt = cleanText($el.attr('alt') || '');
        if (!alt) {
            const newAlt = buildAlt($, $el);
            $el.attr('alt', newAlt);
            altsAdded++;
            if (samples.length < 3) samples.push({ src: $el.attr('src'), alt: newAlt });
        }

        const loading = ($el.attr('loading') || '').trim().toLowerCase();
        if (!loading) {
            $el.attr('loading', 'lazy');
            lazyAdded++;
        }
    });

    const changed = altsAdded + lazyAdded;
    return changed > 0
        ? { html: $.html(), altsAdded, lazyAdded, samples }
        : null;
}

// --- old Main ---
// (async () => {
//     const log = [];
//     const tasks = [];

//     for await (const post of listAllPosts()) {
//         tasks.push(limit(async () => {
//             const result = rewriteBody(post.postBody);
//             if (!result) return;

//             log.push({
//                 id: post.id,
//                 name: post.name,
//                 altsAdded: result.altsAdded,
//                 lazyAdded: result.lazyAdded,
//                 samples: result.samples,   // first 3 alt decisions per post
//             });

//             if (!DRY_RUN) {
//                 await api(`/${post.id}/draft`, {
//                     method: 'PATCH',
//                     body: JSON.stringify({ postBody: result.html }),
//                 });
//                 console.log(`Draft updated (alts: ${result.altsAdded}, lazy: ${result.lazyAdded}): ${post.name}`);
//             } else {
//                 console.log(`[DRY RUN] alts: ${result.altsAdded}, lazy: ${result.lazyAdded} — ${post.name}`);
//             }
//         }));
//     }

//     await Promise.all(tasks);
//     fs.writeFileSync('changed-posts.json', JSON.stringify(log, null, 2));
//     console.log(`\nDone. ${log.length} posts ${DRY_RUN ? 'would be' : 'were'} updated.`);
//     console.log(`Log written to changed-posts.json`);
// })();


// new Main

(async () => {
  const log = [];

  // Fetch the targeted slice of posts
  const posts = await fetchPostsInRange();

  console.log(`Selected ${posts.length} posts for this batch:\n`);
  posts.forEach((p, i) => console.log(`  ${START + i}. ${p.name} (${p.id})`));
  console.log('');

  const tasks = posts.map(post => limit(async () => {
    const result = rewriteBody(post.postBody);
    if (!result) return;

    log.push({
      id: post.id,
      name: post.name,
      altsAdded: result.altsAdded,
      lazyAdded: result.lazyAdded,
      samples: result.samples,   // first 3 alt decisions per post
    });

    if (!DRY_RUN) {
      await api(`/${post.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({ postBody: result.html }),
      });
      console.log(`Draft updated (alts: ${result.altsAdded}, lazy: ${result.lazyAdded}): ${post.name}`);
    } else {
      console.log(`[DRY RUN] alts: ${result.altsAdded}, lazy: ${result.lazyAdded} — ${post.name}`);
    }
  }));

  await Promise.all(tasks);

  const fname = `changed-posts-${START}-${END}.json`;
  fs.writeFileSync(fname, JSON.stringify(log, null, 2));
  console.log(`\nDone. ${log.length} posts ${DRY_RUN ? 'would be' : 'were'} updated.`);
  console.log(`Log written to ${fname}`);
})();