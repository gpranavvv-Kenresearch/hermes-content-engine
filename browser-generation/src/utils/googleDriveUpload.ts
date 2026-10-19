/**
 * googleDriveUpload.ts — upload a local file to Google Drive (drive.file
 * scope — only touches files this app itself created) and return a public,
 * hotlinkable URL. Used for the blog cover-image step: ChatGPT's generated
 * image only exists inside the chat, so it needs a real public URL before it
 * can go in an <img src="..."> tag or get posted anywhere.
 *
 * Credentials: .accounts/google-drive-oauth-client.json (OAuth client) +
 * .accounts/google-drive-token.json (refresh token — access token auto-
 * refreshes and is re-persisted to this same file via the 'tokens' event, so
 * you only ever do the OAuth consent flow once).
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const CLIENT_PATH = path.resolve('.accounts/google-drive-oauth-client.json');
const TOKEN_PATH = path.resolve('.accounts/google-drive-token.json');

let cachedClient: InstanceType<typeof google.auth.OAuth2> | null = null;

function getOAuthClient() {
  if (cachedClient) return cachedClient;

  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(`Google Drive OAuth client not found at ${CLIENT_PATH}`);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Google Drive token not found at ${TOKEN_PATH} — run the OAuth consent flow once first.`);
  }

  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

  const client = new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris[0]);
  client.setCredentials({
    access_token: token.token,
    refresh_token: token.refresh_token,
    expiry_date: token.expiry ? new Date(token.expiry).getTime() : undefined,
  });

  // Persist a refreshed access token back to disk so future runs don't need
  // to hit the token endpoint again until this one also expires.
  client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const merged = {
        ...current,
        token: newTokens.access_token ?? current.token,
        refresh_token: newTokens.refresh_token ?? current.refresh_token,
        expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : current.expiry,
      };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    } catch { /* best effort — worst case we refresh again next run */ }
  });

  cachedClient = client;
  return client;
}

/**
 * Upload a local file to Google Drive, make it publicly viewable, and return
 * a hotlinkable URL (the same lh3.googleusercontent.com/d/<id> format used
 * for reference images elsewhere in this pipeline).
 */
export async function uploadFileToGoogleDrive(
  localFilePath: string,
  folderId?: string,
): Promise<{ fileId: string; url: string }> {
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Local file not found: ${localFilePath}`);
  }

  const auth = getOAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const fileName = path.basename(localFilePath);
  const mimeType = fileName.toLowerCase().endsWith('.png') ? 'image/png'
    : fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf'
    : 'application/octet-stream';

  const createRes = await drive.files.create({
    requestBody: {
      name: fileName,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: {
      mimeType,
      body: fs.createReadStream(localFilePath),
    },
    fields: 'id',
  });

  const fileId = createRes.data.id;
  if (!fileId) throw new Error('Google Drive upload succeeded but returned no file id');

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return { fileId, url: `https://lh3.googleusercontent.com/d/${fileId}` };
}
