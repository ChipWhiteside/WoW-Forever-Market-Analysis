/**
 * One command setup on Chip's PC:  npm install  then  npm run setup
 * 1. Checks Node. 2. Asks for anything missing in .env. 3. Proves the Blizzard credentials and the Discord webhook work.
 * 4. Builds the app. 5. Registers the engine to start at login and restart if it ever stops. 6. Starts it and opens the app.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { PROJECT_ROOT, loadDotEnv } from '../src/config/env.ts';
import { BlizzardClient } from '../src/blizzard/client.ts';
import { HouseIndex } from '../src/blizzard/contracts.ts';
import { sendDiscord } from '../src/alerts/discord.ts';

const say = (m: string) => console.log(m);
const ok = (m: string) => console.log(`  OK    ${m}`);
const warn = (m: string) => console.log(`  NOTE  ${m}`);

async function main() {
  say('\nWoW Forever Gold Finder setup\n');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj! < 22 || (maj === 22 && min! < 13)) { say(`Node ${process.versions.node} is too old. Install Node 22 LTS or newer from nodejs.org, then run this again.`); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  const envPath = join(PROJECT_ROOT, '.env');
  loadDotEnv(envPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (key: string, q: string, fallback = '') => {
    if (process.env[key]) return process.env[key]!;
    const a = (await rl.question(`${q}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
    process.env[key] = a;
    return a;
  };
  const id = await ask('BLIZZARD_CLIENT_ID', 'Blizzard client ID', '2a952e578c7a4c8daf3e6736d08932da');
  const secret = await ask('BLIZZARD_CLIENT_SECRET', 'Blizzard client secret (from develop.battle.net, never paste it anywhere else)');
  const hook = await ask('DISCORD_WEBHOOK_URL', 'Discord webhook for #gold-plays, market alerts (Enter to skip for now)');
  const devHook = await ask('DISCORD_DEV_WEBHOOK_URL', 'Discord webhook for #gold-dev, logs and health (Enter to skip for now)');
  rl.close();
  const lines = [`BLIZZARD_CLIENT_ID=${id}`, `BLIZZARD_CLIENT_SECRET=${secret}`, `DISCORD_WEBHOOK_URL=${hook}`, `DISCORD_DEV_WEBHOOK_URL=${devHook}`];
  if (process.env.DATA_DIR) lines.push(`DATA_DIR=${process.env.DATA_DIR}`);
  if (process.env.PORT) lines.push(`PORT=${process.env.PORT}`);
  writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  ok('.env written (ignored by git)');

  try {
    const client = new BlizzardClient(id, secret);
    const r = await client.get(client.url('/data/wow/ruleset/2/auctions/', 'dynamic'), HouseIndex);
    ok(`Blizzard answers: ${r.body?.auctions.length ?? 0} auction houses`);
  } catch (e) {
    say(`\n  FAILED  Blizzard rejected the credentials: ${(e as Error).message}\n  Check the ID and secret in .env. A regenerated secret replaces the old one.\n`);
    process.exit(1);
  }
  if (hook) {
    (await sendDiscord(hook, 'Gold Finder is connected. Plays will land here, only when there is something worth your time.')) ? ok('Discord test message sent') : warn('Discord did not accept the webhook. Fix DISCORD_WEBHOOK_URL in .env later, alerts are skipped until then.');
  } else warn('No Discord webhook yet. The app still works, alerts start once you add one to .env.');
  if (devHook) (await sendDiscord(devHook, 'Gold Finder dev channel connected. Loop summaries and health problems land here.')) ? ok('Discord dev channel test sent') : warn('Discord did not accept the dev webhook.');

  execSync('npm run build:web', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  ok('app built');

  registerAutostart();
  const port = Number(process.env.PORT || 4242);
  say(`\nDone. The engine is running in the background and starts again at every login.`);
  say(`Open http://localhost:${port} (in Chrome or Edge: menu, Install app, for a desktop window).\n`);
  say(`Next: Settings, House finder. Pick the two houses whose Copper Ore and Linen Cloth prices match the game.\n`);
}

function registerAutostart() {
  const node = process.execPath;
  const cli = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const main = join(PROJECT_ROOT, 'src', 'engine', 'main.ts');
  const logDir = join(process.env.DATA_DIR || join(homedir(), '.wowf-gold-finder'), 'logs');
  mkdirSync(logDir, { recursive: true });
  const os = platform();
  if (os === 'win32') {
    // A restart loop in a .cmd, launched hidden by a .vbs.
    const cmd = join(PROJECT_ROOT, 'scripts', 'run-engine.cmd');
    writeFileSync(cmd, `@echo off\r\ncd /d "${PROJECT_ROOT}"\r\n:loop\r\n"${node}" "${cli}" "${main}" >> "${join(logDir, 'engine.log')}" 2>&1\r\ntimeout /t 15 /nobreak > nul\r\ngoto loop\r\n`);
    const vbs = join(PROJECT_ROOT, 'scripts', 'run-engine-hidden.vbs');
    writeFileSync(vbs, `CreateObject("Wscript.Shell").Run """${cmd}""", 0, False\r\n`);
    // The Startup folder runs at every logon and needs no admin rights. Task Scheduler logon tasks do.
    const startup = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    mkdirSync(startup, { recursive: true });
    writeFileSync(join(startup, 'WoWF Gold Finder.vbs'), `CreateObject("Wscript.Shell").Run """${cmd}""", 0, False\r\n`);
    try { execSync('schtasks /Delete /F /TN "WoWF Gold Finder"', { stdio: 'ignore' }); } catch { /* never registered */ }
    // Stop a copy that may already be running, then start it now in the background.
    // Stop any copy already running (its restart loop and its node process), so running setup twice never doubles it.
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-engine.cmd*' -or $_.CommandLine -like '*engine\\main.ts*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }";
    try { execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore' }); } catch { /* none running */ }
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
    ok(`starts at every login from your Startup folder, restarts itself if it stops. Logs: ${join(logDir, 'engine.log')}`);
  } else if (os === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.wowf.goldfinder.plist');
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.wowf.goldfinder</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>${main}</string></array>
<key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${join(logDir, 'engine.log')}</string><key>StandardErrorPath</key><string>${join(logDir, 'engine.log')}</string>
</dict></plist>`);
    try { execSync(`launchctl unload "${plist}"`, { stdio: 'ignore' }); } catch { /* not loaded */ }
    execSync(`launchctl load "${plist}"`);
    ok('registered with launchd (runs at login, restarts on crash)');
  } else {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'wowf-gold-finder.service'), `[Unit]\nDescription=WoW Forever Gold Finder\n\n[Service]\nWorkingDirectory=${PROJECT_ROOT}\nExecStart=${node} ${cli} ${main}\nRestart=always\nRestartSec=15\n\n[Install]\nWantedBy=default.target\n`);
    try { execSync('systemctl --user daemon-reload && systemctl --user enable --now wowf-gold-finder', { stdio: 'inherit' }); ok('registered as a systemd user service'); }
    catch { warn(`could not enable systemd; start it yourself with: npm run engine`); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
