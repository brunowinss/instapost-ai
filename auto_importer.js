const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { getDB } = require('./database');
require('dotenv').config();

const VIDEOS_DIR = path.join(__dirname, 'vídeos_para_postar');
const SLOTS = [10, 15, 20]; // 10h, 15h, 20h

/**
 * Main function to import and schedule videos from the local folder.
 */
async function runAutoImporter() {
  console.log('🤖 Starting Auto-Importer...');
  const db = await getDB();
  
  // 1. Get API Configs
  const configRows = await db.all('SELECT * FROM global_config');
  const config = {};
  configRows.forEach(r => config[r.key] = JSON.parse(r.value));
  
  if (!config.cloudinaryName || !config.cloudinaryPreset) {
    console.error('❌ Cloudinary config missing! Please set in UI Settings.');
    return;
  }

  cloudinary.config({
    cloud_name: config.cloudinaryName,
    api_key: process.env.CLOUDINARY_API_KEY, // Optional if using preset
    api_secret: process.env.CLOUDINARY_API_SECRET, // Optional if using preset
    secure: true
  });

  // 2. Scan Folder
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
  const files = fs.readdirSync(VIDEOS_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.mov'));
  
  if (files.length === 0) {
    console.log('📂 No videos found in folder.');
    return;
  }

  // 3. Get Active Account
  const account = await db.get('SELECT "accountId" FROM accounts LIMIT 1');
  if (!account) {
    console.error('❌ No Instagram account connected!');
    return;
  }

  // 4. Process files
  for (const file of files) {
    const filePath = path.join(VIDEOS_DIR, file);
    
    // Check if already imported
    const exists = await db.get('SELECT id FROM posts WHERE "sourceFile" = ?', [file]);
    if (exists) continue;

    console.log(`🎬 Processing: ${file}`);
    
    try {
      // a) Upload to Cloudinary
      // node-fetch is used in server.js, but here we use cloudinary sdk for ease
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        upload_preset: config.cloudinaryPreset
      });
      
      const videoUrl = result.secure_url;
      
      // b) Calculate Next Slot
      const scheduledAt = await calculateNextSlot(db);
      
      // c) Save to DB
      const postId = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const params = [
        postId,
        account.accountId,
        'REELS',
        videoUrl,
        file.replace(/\.[^/.]+$/, "").replace(/_/g, " "), // Clean filename for caption
        scheduledAt.toISOString(),
        'pending',
        '', // mediaId
        '', // publishedAt
        new Date().toISOString(),
        file
      ];

      await db.run(`INSERT INTO posts ("id", "accountId", "mediaType", "imageUrl", "caption", "scheduledAt", "status", "mediaId", "publishedAt", "createdAt", "sourceFile") 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params);
      
      console.log(`✅ Scheduled: ${file} at ${scheduledAt.toLocaleString()}`);

    } catch (err) {
      console.error(`❌ Error importing ${file}:`, err.message);
    }
  }
}

/**
 * Finds the next available time slot (10h, 15h, 20h).
 */
async function calculateNextSlot(db) {
  // Get latest scheduled post
  const lastPost = await db.get('SELECT "scheduledAt" FROM posts WHERE "status" = \'pending\' ORDER BY "scheduledAt" DESC LIMIT 1');
  
  let baseDate = new Date();
  if (lastPost) {
    baseDate = new Date(lastPost.scheduledAt);
  }

  // Find next slot
  let nextDate = new Date(baseDate);
  let found = false;

  while (!found) {
    // Check slots for the current nextDate
    for (const hour of SLOTS) {
      const slotTime = new Date(nextDate);
      slotTime.setHours(hour, 0, 0, 0);
      
      // Slot must be at least 30 mins in the future
      if (slotTime > new Date(baseDate) && slotTime > new Date(Date.now() + 30 * 60000)) {
        nextDate = slotTime;
        found = true;
        break;
      }
    }
    
    if (!found) {
      // Move to next day
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(0, 0, 0, 0);
    }
  }

  return nextDate;
}

module.exports = { runAutoImporter };
