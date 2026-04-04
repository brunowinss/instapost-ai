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

  // 2. Scan for Subfolders (One for each Account Username)
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
  const subfolders = fs.readdirSync(VIDEOS_DIR).filter(f => fs.statSync(path.join(VIDEOS_DIR, f)).isDirectory());
  
  if (subfolders.length === 0) {
    console.log('📂 No account subfolders found in vídeos_para_postar.');
    return;
  }

  // 3. Get Latest Global Schedule to start from (to avoid overlap)
  let lastScheduledDate = await db.get('SELECT "scheduledAt" FROM posts WHERE "status" = \'pending\' ORDER BY "scheduledAt" DESC LIMIT 1');
  let currentBasis = lastScheduledDate ? new Date(lastScheduledDate.scheduledAt) : new Date();

  // 4. Process each subfolder
  for (const folderName of subfolders) {
    const folderPath = path.join(VIDEOS_DIR, folderName);
    
    // Find account by username matching folder name
    const account = await db.get('SELECT "accountId", "username" FROM accounts WHERE "username" = ?', [folderName]);
    if (!account) {
      console.warn(`⚠️ Folder "${folderName}" ignored. No connected account with this username.`);
      continue;
    }

    console.log(`📂 Processing niche for @${account.username}...`);
    
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.mp4') || f.endsWith('.mov'));
    
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      
      // Check if already imported
      const exists = await db.get('SELECT id FROM posts WHERE "sourceFile" = ? AND "accountId" = ?', [file, account.accountId]);
      if (exists) continue;

      console.log(`🎬 Processing: ${file} for @${account.username}`);
      
      try {
        // a) Upload to Cloudinary
        const result = await cloudinary.uploader.upload(filePath, {
          resource_type: 'video',
          upload_preset: config.cloudinaryPreset
        });
        
        const videoUrl = result.secure_url;
        
        // b) Calculate Next Slot (Sequential)
        const scheduledAt = await calculateNextSlotFromDate(currentBasis);
        currentBasis = new Date(scheduledAt); // Update basis for next file

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
}

/**
 * Finds the next available time slot (10h, 15h, 20h) after a specific date.
 */
async function calculateNextSlotFromDate(baseDate) {
  const SLOTS = [10, 15, 20];
  let nextDate = new Date(baseDate);
  let found = false;

  const minimumLeadTime = new Date(Date.now() + 30 * 60000); // 30 mins from now

  while (!found) {
    for (const hour of SLOTS) {
      const slotTime = new Date(nextDate);
      slotTime.setHours(hour, 0, 0, 0);
      
      if (slotTime > baseDate && slotTime > minimumLeadTime) {
        nextDate = slotTime;
        found = true;
        break;
      }
    }
    
    if (!found) {
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(0, 0, 0, 0);
    }
  }

  return nextDate;
}

module.exports = { runAutoImporter };
