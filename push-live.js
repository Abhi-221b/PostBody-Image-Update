import 'dotenv/config';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import fs from 'fs';

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) throw new Error('Missing HUBSPOT_TOKEN in .env');

const BASE = 'https://api.hubapi.com/cms/blogs/2026-03/posts';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const CONFIRM = true;     // ← set to true to actually push live
const limit   = pLimit(3);

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

(async () => {
  if (!fs.existsSync('changed-posts.json')) {
    throw new Error('changed-posts.json not found. Run update-alts.js first.');
  }

  const posts = JSON.parse(fs.readFileSync('changed-posts.json', 'utf8'));
  console.log(`Found ${posts.length} posts to push live.`);

  if (!CONFIRM) {
    console.log('CONFIRM is false — exiting without changes.');
    console.log('Set CONFIRM = true in the script to push drafts live.');
    return;
  }

  const failures = [];

  await Promise.all(posts.map(post => limit(async () => {
    try {
      await api(`/${post.id}/draft/push-live`, { method: 'POST' });
      console.log(`Pushed live: ${post.name}`);
    } catch (err) {
      console.error(`FAILED: ${post.name} (${post.id}) — ${err.message}`);
      failures.push({ ...post, error: err.message });
    }
  })));

  if (failures.length) {
    fs.writeFileSync('failed-pushes.json', JSON.stringify(failures, null, 2));
    console.log(`\n${failures.length} failures written to failed-pushes.json`);
  } else {
    console.log('\nAll posts pushed live successfully.');
  }
})();