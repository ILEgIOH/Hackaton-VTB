const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const [,, mode, a, b]=process.argv;const times=(mode==='shots')?[16.5,18,21,23.5,25,28,30]:null;
(async()=>{const br=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await (await br.newContext({viewport:{width:1920,height:1080}})).newPage();p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>m.type()==='error'&&console.log('C',m.text()));
await p.goto('http://localhost:8899/index.html');await p.waitForSelector('body[data-ok]',{timeout:60000});await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(500);
const fs=require('fs'),OUT=require('path').join(__dirname,'out');fs.mkdirSync(OUT+'/fr',{recursive:true});
if(times){for(const t of times){const t0=Date.now();await p.evaluate(t=>seek(t),t);await p.screenshot({path:`${OUT}/s${t}.png`});console.log(t,Date.now()-t0,'ms')}}
else{for(let i=+a;i<+b;i++){await p.evaluate(t=>seek(t),i/30);await p.screenshot({path:`${OUT}/fr/f${String(i).padStart(4,'0')}.jpg`,type:'jpeg',quality:93})}}
await br.close()})()
