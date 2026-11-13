// Собирает dist/modus-signal.html — один файл без сервера (автономный демо-режим)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'public/core.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/workspace.css'), 'utf8');
const authUi = fs.readFileSync(path.join(root, 'public/auth-ui.js'), 'utf8');
const displayUi = fs.readFileSync(path.join(root, 'public/display-ui.js'), 'utf8');
const teamUi = fs.readFileSync(path.join(root, 'public/team-ui.js'), 'utf8');
const teamCss = fs.readFileSync(path.join(root, 'public/team.css'), 'utf8');
const reports = fs.readFileSync(path.join(root,'server/owner-reports.js'),'utf8');
const out = html.replace('<head>',()=>'<head><script>window.ModusReports=(function(){const module={exports:{}};'+reports.replace(/<\/script/gi,'<\\/script')+';return module.exports;})();</script>').replace('<script src="core.js"></script>', () => '<script>\n' + core.replace(/<\/script/gi, '<\\/script') + '\n</script>')
  .replace('<script src="auth-ui.js"></script>', () => '<script>\n' + authUi.replace(/<\/script/gi, '<\\/script') + '\n</script>')
  .replace('<script src="display-ui.js"></script>', () => '<script>\n' + displayUi.replace(/<\/script/gi, '<\\/script') + '\n</script>')
  .replace('<script src="team-ui.js"></script>', () => '<script>\n' + teamUi.replace(/<\/script/gi, '<\\/script') + '\n</script>')
  .replace('<link rel="stylesheet" href="team.css">', () => '<style>\n' + teamCss + '\n</style>')
  .replace('<link rel="stylesheet" href="workspace.css">', () => '<style>\n' + css + '\n</style>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/modus-signal.html'), out);
console.log('dist/modus-signal.html', (out.length / 1024).toFixed(0) + ' KB');

fs.mkdirSync(path.join(root,'dist/pages'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/pages/index.html'),out.replace('<head>', '<head><script>window.MODUS_STATIC_DEMO=true;</script>'));
fs.copyFileSync(path.join(root,'public/telegram-avatar.png'),path.join(root,'dist/pages/telegram-avatar.png'));
const tutorialFiles=['index.html','modus-signal-guide.mp4','poster.jpg','captions.vtt','chapters.json'];
if(tutorialFiles.every(file=>fs.existsSync(path.join(root,'docs/tutorial',file)))){
  fs.mkdirSync(path.join(root,'dist/pages/tutorial'),{recursive:true});
  for(const file of tutorialFiles)fs.copyFileSync(path.join(root,'docs/tutorial',file),path.join(root,'dist/pages/tutorial',file));
}
