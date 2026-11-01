// Покадровый рендер promo/motion3d.html в JPEG 1920×1080: node promo/render_frames.js <с кадра> <по кадр>
// Нужен Playwright: npm i -g playwright && npx playwright install chromium. Свой браузер: CHROME_PATH=/путь/к/chrome
const path = require('path'), fs = require('fs');
let pw; try { pw = require('playwright'); } catch { pw = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }
const [, , a = '0', b = '0'] = process.argv; const FPS = 30;
const PAGE = 'file://' + path.join(__dirname, 'motion3d.html'), OUT = path.join(__dirname, 'frames');
(async () => {
  const br = await pw.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const p = await (await br.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(PAGE); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500);
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = +a; i < +b; i++) { await p.evaluate(t => seek(t), i / FPS); await p.screenshot({ path: path.join(OUT, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 }); }
  await br.close();
})();
