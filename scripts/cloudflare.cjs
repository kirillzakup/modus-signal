'use strict';
// This project has its own login, separate from other Cloudflare projects.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const configPath = fs.existsSync(path.join(root,'config/wrangler.local.jsonc')) ? path.join(root,'config/wrangler.local.jsonc') : path.join(root,'wrangler.jsonc');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
// Local config is kept at root-relative paths for Wrangler.
const runConfig = path.join(root, '.wrangler.local.jsonc');
if (configPath.includes('wrangler.local')) fs.writeFileSync(runConfig,JSON.stringify(config));
const env = { ...process.env,
  XDG_CONFIG_HOME: path.join(process.env.LOCALAPPDATA || process.env.HOME, 'ModusSignal', 'CloudflareAuth'),
  WRANGLER_SEND_METRICS: 'false'
};
delete env.CLOUDFLARE_API_TOKEN;
delete env.CLOUDFLARE_API_KEY;
delete env.CLOUDFLARE_EMAIL;
delete env.CF_API_TOKEN;
delete env.CF_API_KEY;
const args = process.argv.slice(2);
if (!args.length) { console.error('Specify a Wrangler command'); process.exit(1); }
const local = ['login','whoami','dev','types','--help'].includes(args[0]) || args.includes('--dry-run');
if (!local) {
  const check = spawnSync(process.execPath, [cli,'whoami'], { cwd: root, env, encoding:'utf8', windowsHide:true });
  if (!config.account_id || check.status !== 0 || !check.stdout.includes(config.account_id)) {
    console.error('Deployment stopped: sign in to the Cloudflare account selected for Modus Signal using npm run cloudflare:login.');
    process.exit(1);
  }
}
const result = spawnSync(process.execPath,[cli,...args,...(configPath.includes('wrangler.local')?['--config',runConfig]:[])],{cwd:root,env,stdio:'inherit',windowsHide:true});
process.exit(result.status == null ? 1 : result.status);
