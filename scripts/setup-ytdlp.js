/** Download (or update) the managed yt-dlp binary into ./bin. The bot also does this automatically on start. */
import fs from 'node:fs';
import { downloadYtDlp, getVersion, managedBinaryPath, updateYtDlp } from '../src/music/ytdlpBinary.js';

const target = managedBinaryPath();
if (fs.existsSync(target)) {
  console.log(`yt-dlp present (${await getVersion(target)}), checking for updates...`);
  await updateYtDlp(target, { info: (o, m) => console.log(m, o), warn: (o, m) => console.warn(m, o) });
} else {
  await downloadYtDlp(target, { info: (o, m) => console.log(m, o) });
}
console.log(`yt-dlp ready at ${target} (version ${await getVersion(target)})`);
