// DevDeck: ajanı oturum açılışında başlatmayı kurar veya kaldırır (Windows ve macOS).
//   node scripts/autostart.js            -> kur ve hemen başlat
//   node scripts/autostart.js --remove   -> kaldır
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const remove = process.argv.includes('--remove');

if (process.platform === 'win32') {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'autostart.ps1'),
    ...(remove ? ['-Remove'] : [])], { stdio: 'inherit' });
  if (!remove && r.status === 0) {
    spawn('wscript.exe', [path.join(__dirname, 'devdeck-hidden.vbs')], { detached: true, stdio: 'ignore' }).unref();
    console.log('Ajan arka planda başlatıldı.');
  }
  process.exit(r.status || 0);
}

if (process.platform === 'darwin') {
  // LaunchAgent: oturum açılınca çalışır. launchd'nin PATH'i dar olduğu için adb'nin olası yerleri eklenir.
  const label = 'com.devdeck.agent';
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
  if (remove) {
    if (fs.existsSync(plist)) { fs.unlinkSync(plist); console.log('Otomatik başlatma kaldırıldı.'); } else console.log('Zaten kurulu değil.');
    process.exit(0);
  }
  const PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), 'Library/Android/sdk/platform-tools'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const log = path.join(root, 'devdeck.log');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(path.join(root, 'server', 'index.js'))}</string></array>
  <key>WorkingDirectory</key><string>${x(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict></plist>
`);
  const r = spawnSync('launchctl', ['load', plist], { stdio: 'inherit' });
  console.log(r.status === 0 ? `Otomatik başlatma kuruldu ve ajan başlatıldı: ${plist}` : 'launchctl load başarısız oldu.');
  process.exit(r.status || 0);
}

console.error(`Desteklenmeyen işletim sistemi: ${process.platform}`);
process.exit(1);
