const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const fs=require('fs');const [,, a, b]=process.argv;const FPS=30;
(async()=>{const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await (await br.newContext({viewport:{width:1920,height:1080}})).newPage();
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('file:///tmp/claude-0/m3d/index.html');await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(500);
fs.mkdirSync('/tmp/claude-0/m3d/fr',{recursive:true});
for(let i=+a;i<+b;i++){await p.evaluate(t=>seek(t),i/FPS);await p.screenshot({path:`/tmp/claude-0/m3d/fr/f${String(i).padStart(4,'0')}.jpg`,type:'jpeg',quality:92})}
await br.close()})()
